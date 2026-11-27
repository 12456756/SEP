#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SERVER_HOST=${SERVER_HOST:?SERVER_HOST is required}
SERVER_USER=${SERVER_USER:-root}
SERVER_PORT=${SERVER_PORT:-22}
SERVER_SSH_KEY=${SERVER_SSH_KEY:?SERVER_SSH_KEY is required}
RELEASE_SHA=${GITHUB_SHA:-$(git rev-parse HEAD)}
RELEASE_ACTION=${SEP_DEPLOY_ACTION:-rehearse}
[[ "$RELEASE_ACTION" =~ ^(rehearse|stage|activate|rollback|status)$ ]] || { echo 'Unsupported isolated deployment action' >&2; exit 1; }
KNOWN_HOSTS=$(cd "$(dirname "${BASH_SOURCE[0]}")/../deploy/standalone" && pwd)/known_hosts

[[ "$SERVER_HOST" == 121.37.128.126 ]] || { echo 'SERVER_HOST must be the standalone SEP server' >&2; exit 1; }
[[ "$SERVER_PORT" == 22 ]] || { echo 'The pinned standalone server host key is valid for SSH port 22 only' >&2; exit 1; }
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'GITHUB_SHA must be a full commit SHA' >&2; exit 1; }
SOURCE_REPOSITORY=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
[[ "$SOURCE_REPOSITORY" == 12456756/SEP ]] || { echo 'Unexpected production source repository' >&2; exit 1; }
SOURCE_URL="https://codeload.github.com/$SOURCE_REPOSITORY/tar.gz/$RELEASE_SHA"
RELEASE_TAG=${RELEASE_SHA:0:12}
if [[ -n "${GITHUB_RUN_ID:-}" || -n "${GITHUB_RUN_ATTEMPT:-}" ]]; then
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must both be positive integers' >&2
    exit 1
  }
  ATTEMPT_HASH=$(printf '%s:%s' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" | sha256sum | cut -c1-12)
  RELEASE_TAG="$RELEASE_TAG-$ATTEMPT_HASH"
fi
if [[ -n "${SEP_DEPLOY_TAG:-}" ]]; then
  [[ "$SEP_DEPLOY_TAG" =~ ^[a-f0-9]{12}(-[a-f0-9]{12})?$ ]] || { echo 'Invalid isolated release tag' >&2; exit 1; }
  if [[ "$RELEASE_ACTION" == rehearse || "$RELEASE_ACTION" == stage ]]; then
    [[ "$SEP_DEPLOY_TAG" == "${RELEASE_SHA:0:12}"* ]] || { echo 'Release tag must belong to the selected commit' >&2; exit 1; }
  fi
  RELEASE_TAG=$SEP_DEPLOY_TAG
fi
if [[ "$RELEASE_ACTION" != rehearse && -z "${SEP_DEPLOY_TAG:-}" ]]; then
  echo 'Select the tag printed by the successful rehearsal' >&2
  exit 1
fi
echo "Release commit: $RELEASE_SHA; artifact: $RELEASE_TAG"

REMOTE_TMP_DIR=/www/sep/tmp
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
KEY_FILE=$TEMP_DIR/id_ed25519
ARCHIVE=$TEMP_DIR/sep-release.tar.gz
chmod 700 "$TEMP_DIR"
printf '%s\n' "$SERVER_SSH_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
REMOTE_ARCHIVE="$REMOTE_TMP_DIR/sep-release-$RELEASE_SHA.tar.gz"

SSH_OPTIONS=(-i "$KEY_FILE" -p "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
SCP_OPTIONS=(-i "$KEY_FILE" -P "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
if [[ "$RELEASE_ACTION" == activate || "$RELEASE_ACTION" == rollback || "$RELEASE_ACTION" == status ]]; then
  ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$RELEASE_TAG" "$RELEASE_ACTION" <<'CONTROL'
set -Eeuo pipefail
release_tag=$1
release_action=$2
release_source=$(python3 - "$release_tag" "$release_action" <<'PY'
import json
from pathlib import Path
import sys
root = Path('/www/sep/blue-green') / sys.argv[1]
state_path = root / 'final/state.json'
if sys.argv[2] == 'status' and not state_path.exists():
    state_path = root / 'rehearsal/state.json'
state = json.loads(state_path.read_text())
source = Path(state['source']).resolve()
source.relative_to(Path('/www/sep/releases'))
if not (source / 'deploy/standalone/blue-green.py').is_file():
    sys.exit('Original release tool is unavailable')
print(source)
PY
)
python3 "$release_source/deploy/standalone/blue-green.py" "$release_action" --tag "$release_tag"
CONTROL
  exit 0
fi
curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$SOURCE_URL" -o "$ARCHIVE"
ARCHIVE_SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" install -d -m 700 "$REMOTE_TMP_DIR"
if ! timeout --signal=TERM --kill-after=10s 180s scp "${SCP_OPTIONS[@]}" "$ARCHIVE" "$SERVER_USER@$SERVER_HOST:$REMOTE_ARCHIVE"; then
  echo 'Upload failed or exceeded 180 seconds; switching to server-side download of the same archive.'
  ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$SOURCE_URL" "$REMOTE_ARCHIVE" <<'PULL'
set -Eeuo pipefail
umask 077
curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$1" -o "$2"
PULL
fi
ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$RELEASE_SHA" "$ARCHIVE_SHA" "$REMOTE_ARCHIVE" "$RELEASE_TAG" "$RELEASE_ACTION" <<'REMOTE'
set -Eeuo pipefail
release_sha=$1
archive_sha=$2
archive_path=$3
release_tag=$4
release_action=$5
release_root="/www/sep/releases/$release_sha"
mkdir -p "$release_root/source"
printf '%s  %s\n' "$archive_sha" "$archive_path" | sha256sum --check --status
tar -xzf "$archive_path" --strip-components=1 -C "$release_root/source"
rm -f "$archive_path"
cd "$release_root/source"
python3 deploy/standalone/blue-green.py "$release_action" --tag "$release_tag"
REMOTE
