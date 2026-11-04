#!/usr/bin/env bash
# Independent-server release. Source is an immutable archive, not a git pull.
set -Eeuo pipefail
umask 077

RELEASE_SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SEP_DEPLOY_LIBRARY=true source "$RELEASE_SOURCE/deploy/production/sep-deploy.sh"
DEPLOY_DIR=/www/sep/deploy
STATE_DIR=/www/sep/.deploy
LOCK_FILE=/www/sep/.deploy.lock
ENV_FILE=$DEPLOY_DIR/backend.env
CADDYFILE=$DEPLOY_DIR/Caddyfile
CADDY_CONTAINER=sep-caddy
SHARED_NETWORK=sep-migration-net
RELEASE_SHA=${SEP_RELEASE_SHA:?Set SEP_RELEASE_SHA to the archived commit}
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
DEPLOY_TAG=${SEP_RELEASE_TAG:-${RELEASE_SHA:0:12}}
[[ "$DEPLOY_TAG" =~ ^${RELEASE_SHA:0:12}(-[a-f0-9]{12})?$ ]] || exit 1
BACKUP_DIR=/www/sep/backups/release-$(date +%Y%m%d-%H%M%S)-$DEPLOY_TAG
maintenance=false
replaced=false
finished=false
public_open=false

release_value() {
  local key=$1 fallback=$2 value
  value=$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$DEPLOY_DIR/release.env" 2>/dev/null || true)
  printf '%s' "${value:-$fallback}"
}

compose() {
  local args=(--env-file "$DEPLOY_DIR/.env")
  [[ ! -f "$DEPLOY_DIR/release.env" ]] || args+=(--env-file "$DEPLOY_DIR/release.env")
  docker compose --project-directory "$DEPLOY_DIR" "${args[@]}" -f "$DEPLOY_DIR/compose.yaml" "$@"
}

reload_caddy() {
  docker exec sep-caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null
  docker exec sep-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
}

enable_maintenance() {
  cat > "$CADDYFILE" <<'CADDY'
sep.longdaoec.com, longdaosep.cn {
    handle /sep-client/* {
        reverse_proxy sep-downloads:80
    }
    handle {
        header Retry-After 60
        respond "SEP is updating. Please retry shortly." 503
    }
}
CADDY
  cat "$BACKUP_DIR/other-sites.caddy" >> "$CADDYFILE"
  reload_caddy
  [[ "$(curl --noproxy '*' --resolve sep.longdaoec.com:443:127.0.0.1 -sS --max-time 15 -o /dev/null -w '%{http_code}' https://sep.longdaoec.com/)" == 503 ]]
}

queue_idle() {
  local count
  count=$(docker exec sep-redis redis-cli -n 1 --raw EVAL '
    local n=0
    for _,q in ipairs({"task-execution","knowledge-version-processing"}) do
      for _,s in ipairs({"wait","active","paused"}) do n=n+redis.call("LLEN","bull:"..q..":"..s) end
      for _,s in ipairs({"delayed","prioritized","waiting-children"}) do n=n+redis.call("ZCARD","bull:"..q..":"..s) end
    end
    return n' 0)
  [[ "$count" == 0 ]] || { error "Unfinished queue jobs: $count"; return 1; }
}

preflight() {
  [[ "$(id -u)" == 0 && "$(findmnt -n -o SOURCE /www)" == /dev/sdb1 ]]
  docker network inspect "$SHARED_NETWORK" >/dev/null
  check_env
  compose --profile edge config -q
  for name in sep-postgres sep-redis sep-green-backend sep-green-web; do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$name")" == healthy ]]
  done
  python3 - "$RELEASE_SOURCE" /www/sep/source <<'PY'
import json
import difflib
import pathlib
import sys

release_root, baseline_root = map(pathlib.Path, sys.argv[1:])
def read(root, name):
    return json.loads((root / name).read_text())
current = read(release_root, 'package.json')
baseline = read(baseline_root, 'package.json')
current['scripts'].pop('dev', None)
baseline['scripts'].pop('dev', None)
if current != baseline:
    sys.exit(1)
current = read(release_root, 'backend/package.json')
baseline = read(baseline_root, 'backend/package.json')
if current['dependencies'].pop('tar-stream', None) != '^3.2.0' or current != baseline:
    sys.exit(1)
if (release_root / 'web/package.json').read_bytes() != (baseline_root / 'web/package.json').read_bytes():
    sys.exit(1)

release_lines = (release_root / 'pnpm-lock.yaml').read_text().splitlines()
baseline_lines = (baseline_root / 'pnpm-lock.yaml').read_text().splitlines()
allowed = ['      tar-stream:', '        specifier: ^3.2.0', '        version: 3.2.0']
matcher = difflib.SequenceMatcher(a=baseline_lines, b=release_lines, autojunk=False)
additions = []
for tag, a1, a2, b1, b2 in matcher.get_opcodes():
    if tag == 'equal':
        continue
    if tag != 'insert':
        sys.exit(1)
    additions.extend(release_lines[b1:b2])
if additions != allowed:
    sys.exit(1)
PY
  docker exec sep-green-backend node -e '
    const packageJson = require("/app/node_modules/.pnpm/tar-stream@3.2.0/node_modules/tar-stream/package.json");
    if (packageJson.version !== "3.2.0") process.exit(1);
  ' || { error 'Required locked runtime dependency tar-stream@3.2.0 is unavailable'; return 1; }
  grep -Fq 'sep.longdaoec.com' "$CADDYFILE"
  grep -Fq 'reverse_proxy sep-green-web:3000' "$CADDYFILE"
  # The AI site's runtime-managed block is outside SEP's release ownership.
  grep -Fxq '# LONGDAO-AI-BEGIN' "$CADDYFILE"
  grep -Fxq '# LONGDAO-AI-END' "$CADDYFILE"
  [[ "$(env_value API_BASE_URL)" == https://sep.longdaoec.com/api ]]
  local import_enabled import_instance import_min_version
  import_enabled=$(release_value SKILL_IMPORT_ENABLED false)
  import_instance=$(release_value SKILL_IMPORT_INSTANCE_ID '')
  import_min_version=$(release_value SKILL_IMPORT_MIN_CLIENT_VERSION 1.0.0)
  [[ "$import_enabled" == true || "$import_enabled" == false ]]
  if [[ "$import_enabled" == true ]]; then
    [[ "$import_instance" =~ ^[A-Za-z0-9_-]{1,128}$ ]]
  fi
  [[ "$import_min_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
  check_service_readiness green
  docker exec -i sep-green-backend node < "$RELEASE_SOURCE/deploy/standalone/check-billing.cjs"
  queue_idle
  info "Independent-server preflight passed: /www/sep, sep.longdaoec.com"
}

build_images() {
  export SEP_BACKEND_IMAGE=sep-green-backend:$DEPLOY_TAG
  export SEP_WEB_IMAGE=sep-green-web:$DEPLOY_TAG
  export SEP_MIGRATOR_IMAGE=sep-migrator:$DEPLOY_TAG
  local candidate
  for candidate in "$SEP_BACKEND_IMAGE" "$SEP_WEB_IMAGE" "$SEP_MIGRATOR_IMAGE"; do
    if docker image inspect "$candidate" >/dev/null 2>&1; then
      error "Release image already exists; choose a new immutable SEP_RELEASE_TAG: $candidate"
      return 1
    fi
  done
  docker build --pull=false --network=none --target migrator -f "$RELEASE_SOURCE/deploy/standalone/Dockerfile.backend-release" -t "$SEP_MIGRATOR_IMAGE" "$RELEASE_SOURCE"
  docker build --pull=false --network=none --target runner -f "$RELEASE_SOURCE/deploy/standalone/Dockerfile.backend-release" -t "$SEP_BACKEND_IMAGE" "$RELEASE_SOURCE"
  docker build --pull=false --network=none -f "$RELEASE_SOURCE/deploy/standalone/Dockerfile.web-domain" -t "$SEP_WEB_IMAGE" "$RELEASE_SOURCE"
}

rollback() {
  local name
  trap - ERR INT TERM
  set +e
  error "Release failed; restoring the previous application without reverting data"
  if [[ "$maintenance" != true ]]; then return 1; fi
  enable_maintenance || { error 'Cannot confirm maintenance; application retained'; return 1; }
  if [[ "$replaced" == true ]]; then
    if [[ "$public_open" == true && "$(container_state sep-green-backend)" == running ]]; then
      drain_gateway sep-green-backend || { error 'Cannot drain candidate; maintenance retained'; return 1; }
    fi
    for name in sep-green-backend sep-green-web; do
      signal_and_wait_stopped "$name" || { error "Cannot confirm stopped: $name; maintenance retained"; return 1; }
    done
    export SEP_BACKEND_IMAGE=$OLD_BACKEND SEP_WEB_IMAGE=$OLD_WEB SEP_MIGRATOR_IMAGE=$OLD_MIGRATOR
    [[ "$(docker image inspect "$OLD_BACKEND" --format '{{.Id}}')" == "$OLD_BACKEND_ID" ]] || return 1
    [[ "$(docker image inspect "$OLD_WEB" --format '{{.Id}}')" == "$OLD_WEB_ID" ]] || return 1
  fi
  cp "$BACKUP_DIR/compose.yaml" "$DEPLOY_DIR/compose.yaml" || return 1
  if [[ -f "$BACKUP_DIR/release.env" ]]; then
    cp "$BACKUP_DIR/release.env" "$DEPLOY_DIR/release.env" || return 1
  else
    rm -f "$DEPLOY_DIR/release.env" || return 1
  fi
  if [[ "$replaced" == true ]]; then compose up -d --no-deps --force-recreate backend web || return 1; fi
  restart_target sep-green-web || { error 'Previous application recovery failed; maintenance retained'; return 1; }
  cp "$BACKUP_DIR/Caddyfile" "$CADDYFILE" || return 1
  reload_caddy || return 1
  error "Previous application restored; inspect $BACKUP_DIR"
  return 1
}

deploy() {
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || { error 'Another release is running'; return 1; }
  preflight
  OLD_BACKEND=$(docker inspect sep-green-backend --format '{{.Config.Image}}')
  OLD_WEB=$(docker inspect sep-green-web --format '{{.Config.Image}}')
  OLD_MIGRATOR=${SEP_MIGRATOR_IMAGE:-sep-migrator:42fc2644a38b}
  if [[ -f "$DEPLOY_DIR/release.env" ]]; then
    OLD_MIGRATOR=$(awk -F= '$1 == "SEP_MIGRATOR_IMAGE" { print $2 }' "$DEPLOY_DIR/release.env")
    [[ -n "$OLD_MIGRATOR" ]]
  fi
  OLD_BACKEND_ID=$(docker inspect sep-green-backend --format '{{.Image}}')
  OLD_WEB_ID=$(docker inspect sep-green-web --format '{{.Image}}')
  build_images
  mkdir -p "$BACKUP_DIR"
  cp "$DEPLOY_DIR/compose.yaml" "$DEPLOY_DIR/Caddyfile" "$DEPLOY_DIR/backend.env" "$DEPLOY_DIR/.env" "$BACKUP_DIR/"
  [[ ! -f "$DEPLOY_DIR/release.env" ]] || cp "$DEPLOY_DIR/release.env" "$BACKUP_DIR/"
  printf '%s\n' "$RELEASE_SHA" > "$BACKUP_DIR/release-sha"
  printf '%s\n' "$DEPLOY_TAG" > "$BACKUP_DIR/release-tag"
  printf '%s\n' "$OLD_BACKEND $OLD_BACKEND_ID" "$OLD_WEB $OLD_WEB_ID" > "$BACKUP_DIR/previous-images"
  awk '/^# LONGDAO-AI-BEGIN$/ { keep=1 } keep { print }' "$BACKUP_DIR/Caddyfile" > "$BACKUP_DIR/other-sites.caddy"
  cp "$RELEASE_SOURCE/deploy/standalone/Caddyfile" "$BACKUP_DIR/Caddyfile.next"
  cat "$BACKUP_DIR/other-sites.caddy" >> "$BACKUP_DIR/Caddyfile.next"
  # Preserve the inode because Caddy uses a single-file bind mount.
  maintenance=true
  enable_maintenance
  drain_gateway sep-green-backend
  queue_idle
  signal_and_wait_stopped sep-green-backend
  signal_and_wait_stopped sep-green-web
  queue_idle
  docker exec sep-postgres pg_dump -U sep_admin -d sep_prod -Fc > "$BACKUP_DIR/sep_prod.dump"
  docker exec -i sep-postgres pg_restore -l < "$BACKUP_DIR/sep_prod.dump" > "$BACKUP_DIR/pg-restore-list.txt"
  tar -C /www/sep -czf "$BACKUP_DIR/business-files.tar.gz" uploads packages knowledge
  docker exec sep-redis redis-cli --rdb /tmp/sep-release.rdb >/dev/null
  docker cp sep-redis:/tmp/sep-release.rdb "$BACKUP_DIR/redis.rdb"
  docker exec sep-redis rm /tmp/sep-release.rdb
  sha256sum "$BACKUP_DIR/sep_prod.dump" "$BACKUP_DIR/business-files.tar.gz" "$BACKUP_DIR/redis.rdb" > "$BACKUP_DIR/SHA256SUMS"
  cp "$RELEASE_SOURCE/deploy/standalone/compose.yaml" "$DEPLOY_DIR/compose.yaml"
  compose --profile tools run --rm --no-deps -T migrator
  compose --profile tools run --rm --no-deps -T migrator pnpm --filter backend exec prisma migrate status
  docker exec -i sep-postgres psql -X -U sep_admin -d sep_prod -v ON_ERROR_STOP=1 --single-transaction -c 'SET TRANSACTION READ ONLY' -f - < "$RELEASE_SOURCE/deploy/production/postgres/verify-knowledge-schema.sql"
  replaced=true
  compose up -d --no-deps --force-recreate backend web
  # Recreated containers already have the Compose restart policy.
  rm -f "$STATE_DIR/sep-green-backend.restart-policy" "$STATE_DIR/sep-green-web.restart-policy"
  wait_service_healthy sep-green-backend
  wait_service_healthy sep-green-web
  check_service_readiness green
  docker exec -i sep-green-backend node < "$RELEASE_SOURCE/deploy/standalone/check-billing.cjs"
  for iteration in 1 2 3; do
    check_service_readiness green
    sleep 5
  done
  cp "$BACKUP_DIR/Caddyfile.next" "$CADDYFILE"
  public_open=true
  reload_caddy
  curl --noproxy '*' --resolve sep.longdaoec.com:443:127.0.0.1 --fail --max-time 20 -sS https://sep.longdaoec.com/api/health/ready > "$BACKUP_DIR/readiness.json"
  import_enabled=$(release_value SKILL_IMPORT_ENABLED false)
  import_instance=$(release_value SKILL_IMPORT_INSTANCE_ID '')
  import_min_version=$(release_value SKILL_IMPORT_MIN_CLIENT_VERSION 1.0.0)
  printf 'SEP_BACKEND_IMAGE=%s\nSEP_WEB_IMAGE=%s\nSEP_MIGRATOR_IMAGE=%s\nSKILL_IMPORT_ENABLED=%s\nSKILL_IMPORT_INSTANCE_ID=%s\nSKILL_IMPORT_MIN_CLIENT_VERSION=%s\n' \
    "$SEP_BACKEND_IMAGE" "$SEP_WEB_IMAGE" "$SEP_MIGRATOR_IMAGE" \
    "$import_enabled" "$import_instance" "$import_min_version" > "$DEPLOY_DIR/release.env.tmp"
  mv "$DEPLOY_DIR/release.env.tmp" "$DEPLOY_DIR/release.env"
  printf '%s\n' "$RELEASE_SHA" > "$STATE_DIR/active-release"
  printf '%s\n' "$DEPLOY_TAG" > "$STATE_DIR/active-artifact"
  finished=true
  info "Release complete: $RELEASE_SHA; backup: $BACKUP_DIR"
}

if [[ "${SEP_STANDALONE_LIBRARY:-false}" != true ]]; then
  trap 'if (( BASH_SUBSHELL == 0 )) && [[ "$finished" != true ]]; then rollback; fi; exit 1' ERR INT TERM
  case "${1:-check}" in
    check) preflight ;;
    deploy) deploy ;;
    *) error 'Usage: SEP_RELEASE_SHA=<commit> bash sep-deploy.sh check|deploy'; exit 1 ;;
  esac
fi
