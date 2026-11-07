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

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
KEY_FILE=$TEMP_DIR/id_ed25519
ARCHIVE=$TEMP_DIR/sep-release.tar.gz
chmod 700 "$TEMP_DIR"
printf '%s\n' "$SERVER_SSH_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
git archive --format=tar.gz --prefix=source/ "$RELEASE_SHA" > "$ARCHIVE"
ARCHIVE_SHA=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
REMOTE_ARCHIVE="/tmp/sep-release-$RELEASE_SHA.tar.gz"

SSH_OPTIONS=(-i "$KEY_FILE" -p "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
SCP_OPTIONS=(-i "$KEY_FILE" -P "$SERVER_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
scp "${SCP_OPTIONS[@]}" "$ARCHIVE" "$SERVER_USER@$SERVER_HOST:$REMOTE_ARCHIVE"
ssh "${SSH_OPTIONS[@]}" "$SERVER_USER@$SERVER_HOST" bash -s -- "$RELEASE_SHA" "$ARCHIVE_SHA" "$REMOTE_ARCHIVE" <<'REMOTE'
set -Eeuo pipefail
release_sha=$1
archive_sha=$2
archive_path=$3
release_root="/www/sep/releases/$release_sha"
mkdir -p "$release_root"
printf '%s  %s\n' "$archive_sha" "$archive_path" | sha256sum --check --status
tar -xzf "$archive_path" -C "$release_root"
rm -f "$archive_path"
cd "$release_root/source"
SEP_RELEASE_SHA="$release_sha" bash deploy/standalone/sep-deploy.sh check
SEP_RELEASE_SHA="$release_sha" bash deploy/standalone/sep-deploy.sh deploy
REMOTE
