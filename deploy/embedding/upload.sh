#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ACTION=${EMBEDDING_ACTION:-status}
[[ "$ACTION" == install || "$ACTION" == status || "$ACTION" == verify || "$ACTION" == stop ]] || { echo 'Invalid model service action' >&2; exit 1; }
[[ "${GITHUB_REPOSITORY:-}" == 12456756/SEP && "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Use production origin/main' >&2; exit 1; }
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Full commit SHA required' >&2; exit 1; }
[[ "${SERVER_HOST:-}" == 121.37.128.126 && "${SERVER_PORT:-22}" == 22 ]] || { echo 'Unexpected server or port' >&2; exit 1; }
SERVER_USER=${SERVER_USER:-root}
[[ "$SERVER_USER" == root ]] || { echo 'Root required for this isolated installation' >&2; exit 1; }
SERVER_SSH_KEY=${SERVER_SSH_KEY:?SSH key required}
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
printf '%s\n' "$SERVER_SSH_KEY" > "$TEMP/key"
chmod 600 "$TEMP/key"
KNOWN_HOSTS="$SOURCE/../standalone/known_hosts"
OPTIONS=(-i "$TEMP/key" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
if [[ "$ACTION" == status ]]; then
  ssh "${OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s <<'STATUS'
set -euo pipefail
if ! docker inspect sep-ollama >/dev/null 2>&1; then
  echo 'sep-ollama is absent'
  if [[ -f /www/sep-embedding/state/model-manifest ]]; then cat /www/sep-embedding/state/model-manifest; fi
  exit 0
fi
[[ "$(docker inspect sep-ollama --format '{{index .Config.Labels "com.docker.compose.project"}}')" == sep-embedding ]] || {
  echo 'sep-ollama exists but is not owned by sep-embedding' >&2
  exit 1
}
docker inspect sep-ollama --format 'Image={{.Config.Image}} State={{.State.Status}} Health={{if .State.Health}}{{.State.Health.Status}}{{end}} Restarts={{.RestartCount}} OOMKilled={{.State.OOMKilled}}'
if [[ -f /www/sep-embedding/state/model-manifest ]]; then cat /www/sep-embedding/state/model-manifest; fi
STATUS
  exit 0
fi
if [[ "$ACTION" == verify || "$ACTION" == stop ]]; then
  ssh "${OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$ACTION" "$GITHUB_SHA" <<'EXISTING'
set -euo pipefail
action=$1
sha=$2
if [[ ! -d /www/sep-embedding/deploy || ! -f /www/sep-embedding/state/active-release ]]; then
  echo 'sep-ollama installation is not complete' >&2
  exit 1
fi
SEP_EMBEDDING_SHA="$sha" bash /www/sep-embedding/deploy/manage.sh "$action"
EXISTING
  exit 0
fi
IMAGE_ARCHIVE=${IMAGE_ARCHIVE:?Actions must prepare the official runtime image archive}
[[ -s "$IMAGE_ARCHIVE" && -s "$SOURCE/.env" ]]
tar -czf "$TEMP/config.tar.gz" -C "$SOURCE" .env compose.yaml compose.production.yaml manage.sh verify-embedding.cjs
CHECKSUM=$(sha256sum "$TEMP/config.tar.gz" | awk '{print $1}')
IMAGE_CHECKSUM=$(sha256sum "$IMAGE_ARCHIVE" | awk '{print $1}')
REMOTE="/www/sep-embedding/releases/$GITHUB_SHA"
ssh "${OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" install -d -m 700 "$REMOTE"
scp "${OPTIONS[@]}" "$TEMP/config.tar.gz" "$SERVER_USER@$SERVER_HOST:$REMOTE/config.tar.gz"
timeout --signal=TERM --kill-after=15s 1200s scp "${OPTIONS[@]}" "$IMAGE_ARCHIVE" "$SERVER_USER@$SERVER_HOST:$REMOTE/model-images.tar.gz"
ssh "${OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$GITHUB_SHA" "$CHECKSUM" "$IMAGE_CHECKSUM" "$ACTION" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077
sha=$1 checksum=$2 image_checksum=$3 action=$4
release="/www/sep-embedding/releases/$sha"
printf '%s  %s\n' "$checksum" "$release/config.tar.gz" | sha256sum --check --status
printf '%s  %s\n' "$image_checksum" "$release/model-images.tar.gz" | sha256sum --check --status
install -d -m 700 "$release/source"
tar -xzf "$release/config.tar.gz" -C "$release/source"
SEP_EMBEDDING_SHA="$sha" SEP_EMBEDDING_RELEASE_DIR="$release" bash "$release/source/manage.sh" "$action"
REMOTE_SCRIPT
