#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=/www/sep-embedding
DEPLOY=$ROOT/deploy
STATE=$ROOT/state
ACTION=${1:-status}
RELEASE_SHA=${SEP_EMBEDDING_SHA:-}
PHASE=preflight
CONNECTING=false
FINISHED=false
MODEL=bge-m3:sep-790764642607
WEIGHT=daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c

info() { printf '[embedding] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { info "ERROR: $*" >&2; exit 1; }
phase() { PHASE=$1; info "phase=$PHASE"; }
stage_compose() { docker compose --project-directory "$DEPLOY" --env-file "$DEPLOY/.env" -f "$DEPLOY/compose.yaml" "$@"; }
production_compose() { docker compose --project-directory "$DEPLOY" --env-file "$DEPLOY/.env" -f "$DEPLOY/compose.yaml" -f "$DEPLOY/compose.production.yaml" "$@"; }
owned_container() { [[ "$(docker inspect sep-ollama --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)" == sep-embedding ]]; }
on_failure() {
  local code=$?
  trap - EXIT INT TERM
  (( code != 0 )) || return 0
  if [[ "$CONNECTING" == true && "$FINISHED" != true ]] && owned_container; then
    info 'Candidate verification failed; disconnecting only its production network'
    docker network disconnect sep-migration-net sep-ollama || true
  fi
  info "FAILED phase=$PHASE; application containers and database have not been changed"
  exit "${code:-1}"
}
trap on_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$ACTION" == install || "$ACTION" == status || "$ACTION" == verify || "$ACTION" == stop ]] || fail 'Use install|status|verify|stop'
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'A full SEP_EMBEDDING_SHA is required'
[[ "$(id -u)" == 0 ]] || fail 'Root is required'
[[ "$(findmnt -n -o SOURCE /www)" == /dev/sdb1 ]] || fail 'Expected /www data mount is absent'

if [[ "$ACTION" == status ]]; then
  if [[ ! -f "$STATE/active-release" ]]; then info 'Model service installation has not completed'; fi
  if docker inspect sep-ollama >/dev/null 2>&1; then
    owned_container || fail 'sep-ollama belongs to another project'
    docker inspect sep-ollama --format 'Image={{.Config.Image}} State={{.State.Status}} Health={{if .State.Health}}{{.State.Health.Status}}{{end}} Restarts={{.RestartCount}} OOMKilled={{.State.OOMKilled}}'
  else info 'sep-ollama is absent'; fi
  [[ ! -f "$STATE/model-manifest" ]] || cat "$STATE/model-manifest"
  exit 0
fi

install -d -m 700 "$ROOT" "$STATE"
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || fail 'Another model maintenance operation is running'
if [[ "$ACTION" == stop ]]; then
  owned_container || fail 'No owned model container exists'
  production_compose stop ollama
  info 'Only model service stopped; persisted models retained'
  exit 0
fi

if docker inspect sep-ollama >/dev/null 2>&1; then owned_container || fail 'Refusing to modify an unowned container'; fi
if [[ "$ACTION" == verify || -f "$STATE/active-release" ]]; then
  [[ -f "$STATE/active-release" ]] || fail 'Install has not completed'
  docker exec -i sep-green-backend node - quick < "$SOURCE/verify-embedding.cjs"
  info 'Existing installation verified; no pull, restart or reconfiguration performed'
  exit 0
fi

phase validate-baseline
docker network inspect sep-migration-net >/dev/null
for name in sep-green-backend sep-green-web sep-postgres sep-redis; do
  [[ "$(docker inspect "$name" --format '{{.State.Health.Status}}')" == healthy ]] || fail "Unhealthy baseline container: $name"
done
docker exec -i sep-green-backend node - backend-config < "$SOURCE/verify-embedding.cjs"
APP_SHA=$(cat /www/sep/.deploy/active-release)
[[ "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid application release marker'
SCHEMA_CHECK="/www/sep/releases/$APP_SHA/source/deploy/production/postgres/verify-knowledge-schema.sql"
[[ -s "$SCHEMA_CHECK" ]] || fail 'Active schema verification file is unavailable'
docker exec -i sep-postgres psql -X -U sep_admin -d sep_prod -v ON_ERROR_STOP=1 --single-transaction -c 'SET TRANSACTION READ ONLY' -f - < "$SCHEMA_CHECK"
AVAILABLE_KB=$(df --output=avail /www | tail -1 | tr -d ' ')
(( AVAILABLE_KB >= 15 * 1024 * 1024 )) || fail 'Less than 15 GiB free space'
AVAILABLE_MEMORY=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
(( AVAILABLE_MEMORY >= 10 * 1024 * 1024 )) || fail 'Less than 10 GiB available memory'
PENDING_JOBS=$(docker exec sep-postgres psql -X -U sep_admin -d sep_prod -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM knowledge_processing_jobs WHERE status IN ('PENDING','RUNNING')")
[[ "$PENDING_JOBS" == 0 ]] || fail 'Knowledge processing jobs are pending/running; inspect before attaching the model service'
BACKUP="$ROOT/backups/$(date -u +%Y%m%d-%H%M%S)-${RELEASE_SHA:0:12}"
install -d -m 700 "$BACKUP"
docker inspect sep-green-backend sep-green-web --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' > "$BACKUP/application-before.txt"
printf '%s\n' "$APP_SHA" > "$BACKUP/application-sha"

phase initialize-owned-storage
if [[ ! -f "$STATE/owner" ]]; then
  [[ ! -e "$DEPLOY" && ! -e "$ROOT/data" ]] || fail 'Existing unowned config/data requires investigation'
  printf 'sep-embedding-v1\n' > "$STATE/owner"
fi
[[ "$(cat "$STATE/owner")" == sep-embedding-v1 ]] || fail 'Unexpected storage owner marker'
install -d -m 700 "$DEPLOY" "$ROOT/data"
for file in compose.yaml compose.production.yaml verify-embedding.cjs manage.sh; do
  if [[ -f "$DEPLOY/$file" ]]; then cmp "$SOURCE/$file" "$DEPLOY/$file" || fail "Existing installation configuration differs: $file";
  else install -m 600 "$SOURCE/$file" "$DEPLOY/$file"; fi
done

phase prepare-immutable-images
if [[ ! -f "$DEPLOY/.env" ]]; then
  timeout --signal=TERM --kill-after=15s 900s docker pull ollama/ollama:0.33.1
  timeout --signal=TERM --kill-after=15s 600s docker pull node:22-bookworm-slim
  OLLAMA_PIN=$(docker image inspect ollama/ollama:0.33.1 --format '{{index .RepoDigests 0}}')
  NODE_PIN=$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')
  [[ "$OLLAMA_PIN" =~ ^ollama/ollama@sha256:[a-f0-9]{64}$ && "$NODE_PIN" =~ ^node@sha256:[a-f0-9]{64}$ ]] || fail 'Cannot determine immutable image digests'
  printf 'OLLAMA_IMAGE=%s\nPROBE_NODE_IMAGE=%s\n' "$OLLAMA_PIN" "$NODE_PIN" > "$DEPLOY/.env.tmp"
  mv "$DEPLOY/.env.tmp" "$DEPLOY/.env"
fi
grep -Eq '^OLLAMA_IMAGE=ollama/ollama@sha256:[a-f0-9]{64}$' "$DEPLOY/.env"
grep -Eq '^PROBE_NODE_IMAGE=node@sha256:[a-f0-9]{64}$' "$DEPLOY/.env"
stage_compose config -q
production_compose config -q
phase start-isolated-service
stage_compose up -d --no-deps ollama
for attempt in $(seq 1 60); do
  [[ "$(docker inspect sep-ollama --format '{{.State.Health.Status}}')" != healthy ]] || break
  sleep 3
done
[[ "$(docker inspect sep-ollama --format '{{.State.Health.Status}}')" == healthy ]] || fail 'Ollama did not become healthy'
[[ -z "$(docker port sep-ollama)" ]] || fail 'Unexpected public port binding'

phase download-and-verify-model
timeout --signal=TERM --kill-after=15s 1800s docker exec sep-ollama ollama pull bge-m3:567m-fp16
stage_compose run --rm -T --no-deps probe - source < "$SOURCE/verify-embedding.cjs"
printf '%s  %s\n' "$WEIGHT" "$ROOT/data/models/blobs/sha256-$WEIGHT" | sha256sum --check
docker exec sep-ollama ollama cp bge-m3:567m-fp16 "$MODEL"
phase isolated-inference-validation
stage_compose run --rm -T --no-deps probe - full < "$SOURCE/verify-embedding.cjs" | tee "$BACKUP/isolated-verification.jsonl"
[[ "$(docker inspect sep-ollama --format '{{.State.OOMKilled}} {{.RestartCount}}')" == 'false 0' ]] || fail 'Model service restarted or ran out of memory'

phase attach-production-network
[[ "$(cat /www/sep/.deploy/active-release)" == "$APP_SHA" ]] || fail 'Application release changed during preparation; retry later'
CONNECTING=true
production_compose up -d --no-deps ollama
for attempt in $(seq 1 60); do
  [[ "$(docker inspect sep-ollama --format '{{.State.Health.Status}}')" != healthy ]] || break
  sleep 3
done
[[ "$(docker inspect sep-ollama --format '{{.State.Health.Status}}')" == healthy ]] || fail 'Attached Ollama did not become healthy'
phase verify-backend-integration
docker exec -i sep-green-backend node - quick < "$SOURCE/verify-embedding.cjs" | tee "$BACKUP/backend-verification.jsonl"
docker inspect sep-green-backend sep-green-web --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' > "$BACKUP/application-after.txt"
cmp "$BACKUP/application-before.txt" "$BACKUP/application-after.txt" || fail 'Application containers changed during installation'
[[ -z "$(docker port sep-ollama)" ]] || fail 'Unexpected public port binding'
phase record-independent-release
cp "$DEPLOY/.env" "$BACKUP/image-pins.env"
sha256sum "$DEPLOY/compose.yaml" "$DEPLOY/compose.production.yaml" "$DEPLOY/verify-embedding.cjs" > "$BACKUP/config-SHA256SUMS"
printf '%s\n' "$RELEASE_SHA" > "$STATE/active-release.tmp"
printf '%s\n' 'bge-m3:sep-790764642607 sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab' > "$STATE/model-manifest"
mv "$STATE/active-release.tmp" "$STATE/active-release"
printf '%s\n' "$BACKUP" > "$STATE/latest-evidence"
FINISHED=true
info "COMPLETE independent_release=$RELEASE_SHA evidence=$BACKUP application_release_unchanged=$APP_SHA"
