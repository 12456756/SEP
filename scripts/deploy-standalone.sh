#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SERVER_HOST=${SERVER_HOST:?SERVER_HOST is required}
SERVER_USER=${SERVER_USER:-root}
SERVER_PORT=${SERVER_PORT:-22}
SERVER_SSH_KEY=${SERVER_SSH_KEY:?SERVER_SSH_KEY is required}
RELEASE_SHA=${GITHUB_SHA:-$(git rev-parse HEAD)}
KNOWN_HOSTS=$(cd "$(dirname "${BASH_SOURCE[0]}")/../deploy/standalone" && pwd)/known_hosts

[[ "$SERVER_HOST" == 121.37.128.126 ]] || { echo 'SERVER_HOST must be the standalone SEP server' >&2; exit 1; }
[[ "$SERVER_PORT" == 22 ]] || { echo 'The pinned standalone server host key is valid for SSH port 22 only' >&2; exit 1; }
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'GITHUB_SHA must be a full commit SHA' >&2; exit 1; }
SOURCE_REPOSITORY=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
[[ "$SOURCE_REPOSITORY" == 12456756/SEP ]] || { echo 'Unexpected production source repository' >&2; exit 1; }
SOURCE_URL="https://codeload.github.com/$SOURCE_REPOSITORY/tar.gz/$RELEASE_SHA"

REMOTE_TMP_DIR=/www/sep/tmp
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
KEY_FILE=$TEMP_DIR/id_ed25519
ARCHIVE=$TEMP_DIR/sep-release.tar.gz
chmod 700 "$TEMP_DIR"
printf '%s\n' "$SERVER_SSH_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$SOURCE_URL" -o "$ARCHIVE"
ARCHIVE_SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
REMOTE_ARCHIVE="$REMOTE_TMP_DIR/sep-release-$RELEASE_SHA.tar.gz"

SSH_OPTIONS=(-i "$KEY_FILE" -p "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
SCP_OPTIONS=(-i "$KEY_FILE" -P "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" install -d -m 700 "$REMOTE_TMP_DIR"
if ! timeout --signal=TERM --kill-after=10s 180s scp "${SCP_OPTIONS[@]}" "$ARCHIVE" "$SERVER_USER@$SERVER_HOST:$REMOTE_ARCHIVE"; then
  echo 'Upload failed or exceeded 180 seconds; switching to server-side download of the same archive.'
  ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$SOURCE_URL" "$REMOTE_ARCHIVE" <<'PULL'
set -Eeuo pipefail
umask 077
curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$1" -o "$2"
PULL
fi
ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$RELEASE_SHA" "$ARCHIVE_SHA" "$REMOTE_ARCHIVE" <<'REMOTE'
set -Eeuo pipefail
release_sha=$1
archive_sha=$2
archive_path=$3
release_root="/www/sep/releases/$release_sha"
mkdir -p "$release_root/source"
printf '%s  %s\n' "$archive_sha" "$archive_path" | sha256sum --check --status
tar -xzf "$archive_path" --strip-components=1 -C "$release_root/source"
rm -f "$archive_path"
cd "$release_root/source"
SEP_RELEASE_SHA="$release_sha" bash deploy/standalone/sep-deploy.sh check
SEP_RELEASE_SHA="$release_sha" bash deploy/standalone/sep-deploy.sh deploy
REMOTE
