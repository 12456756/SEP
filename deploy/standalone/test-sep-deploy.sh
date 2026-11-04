#!/usr/bin/env bash
set -euo pipefail
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SEP_STANDALONE_LIBRARY=true SEP_RELEASE_SHA=156111539e42d4b6ff6edc51383e003e623ef14d source "$TEST_DIR/sep-deploy.sh"
TEMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TEMP_ROOT"' EXIT
DEPLOY_DIR=$TEMP_ROOT/deploy
BACKUP_DIR=$TEMP_ROOT/backup
CADDYFILE=$DEPLOY_DIR/Caddyfile
mkdir -p "$DEPLOY_DIR" "$BACKUP_DIR"
printf 'SKILL_IMPORT_ENABLED=true\nSKILL_IMPORT_INSTANCE_ID=sep-test-instance\nSKILL_IMPORT_MIN_CLIENT_VERSION=0.4.0\n' > "$DEPLOY_DIR/release.env"
[[ "$(release_value SKILL_IMPORT_ENABLED false)" == true ]]
[[ "$(release_value SKILL_IMPORT_INSTANCE_ID '')" == sep-test-instance ]]
[[ "$(release_value SKILL_IMPORT_MIN_CLIENT_VERSION 1.0.0)" == 0.4.0 ]]
printf 'previous-compose\n' > "$BACKUP_DIR/compose.yaml"
printf 'previous-caddy\n' > "$BACKUP_DIR/Caddyfile"
CALLS=$TEMP_ROOT/calls

enable_maintenance() { printf 'maintenance\n' >> "$CALLS"; }
reload_caddy() { printf 'reload\n' >> "$CALLS"; }
container_state() { echo running; }
drain_gateway() { printf 'drain:%s\n' "$1" >> "$CALLS"; }
signal_and_wait_stopped() { printf 'stop:%s\n' "$1" >> "$CALLS"; }
restart_target() { printf 'restart:%s\n' "$1" >> "$CALLS"; }
compose() { printf 'compose\n' >> "$CALLS"; }
docker() { echo pinned-id; }
OLD_BACKEND=previous-backend OLD_WEB=previous-web OLD_MIGRATOR=previous-migrator
OLD_BACKEND_ID=pinned-id OLD_WEB_ID=pinned-id

# Migration failure must restore durable configuration even before replacement.
maintenance=true replaced=false public_open=false
printf 'new-compose\n' > "$DEPLOY_DIR/compose.yaml"
printf 'new-images\n' > "$DEPLOY_DIR/release.env"
rollback && exit 1
set -e
cmp "$BACKUP_DIR/compose.yaml" "$DEPLOY_DIR/compose.yaml"
[[ ! -f "$DEPLOY_DIR/release.env" ]]
! grep -q '^stop:' "$CALLS"
echo 'PASS: migration failure restores configuration and retained containers'

# A failure after reopening traffic must isolate and drain before any TERM.
printf '' > "$CALLS"
printf 'previous-images\n' > "$BACKUP_DIR/release.env"
maintenance=true replaced=true public_open=true
rollback && exit 1
set -e
cmp "$BACKUP_DIR/release.env" "$DEPLOY_DIR/release.env"
expected=$'maintenance\ndrain:sep-green-backend\nstop:sep-green-backend\nstop:sep-green-web\ncompose\nrestart:sep-green-web\nreload'
[[ "$(cat "$CALLS")" == "$expected" ]]
echo 'PASS: public candidate is fenced and drained before rollback'

# If TERM cannot be confirmed, retain maintenance and never start old workers.
printf '' > "$CALLS"
signal_and_wait_stopped() { printf 'stop-failed\n' >> "$CALLS"; return 1; }
rollback && exit 1
set -e
! grep -q '^compose\|^restart:\|^reload' "$CALLS"
echo 'PASS: stop failure keeps maintenance and prevents duplicate workers'

# A build failure must not touch the running deployment.
printf '' > "$CALLS"
maintenance=false
rollback && exit 1
set -e
[[ ! -s "$CALLS" ]]
echo 'PASS: build failure leaves the running application untouched'

# An existing image tag must never be rebuilt, including an uncommitted overlay.
printf '' > "$CALLS"
DEPLOY_TAG=156111539e42-0123456789ab
docker() {
  if [[ "$1 $2" == 'image inspect' ]]; then return 0; fi
  printf 'unexpected-build\n' >> "$CALLS"
}
build_images && exit 1
set -e
[[ ! -s "$CALLS" ]]
echo 'PASS: existing immutable release tags cannot be overwritten'
