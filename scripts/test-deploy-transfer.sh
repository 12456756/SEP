#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export TEST_CALLS="$TEST_ROOT/calls"
cat > "$TEST_ROOT/bin/mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
tool=${0##*/}
printf '%s %s\n' "$tool" "$*" >> "$TEST_CALLS"
case "$tool" in
  curl)
    while [[ "$1" != -o ]]; do shift; done
    printf 'fixed archive bytes' > "$2"
    ;;
  timeout)
    [[ "$*" == *'180s scp '* ]]
    [[ "${TEST_UPLOAD_FAIL:-false}" != true ]]
    ;;
  ssh)
    if [[ "$*" == *'bash -s --'* ]]; then cat >> "$TEST_CALLS"; fi
    ;;
esac
MOCK
chmod +x "$TEST_ROOT/bin/mock"
for tool in curl timeout ssh; do ln -s mock "$TEST_ROOT/bin/$tool"; done
export PATH="$TEST_ROOT/bin:$PATH"
export SERVER_HOST=121.37.128.126 SERVER_USER=root SERVER_PORT=22
export SERVER_SSH_KEY=test-only-placeholder
export GITHUB_SHA=2edc0d9e788ea47443551454a9920dd35ea10d98
export GITHUB_REPOSITORY=12456756/SEP
export GITHUB_RUN_ID=44512638641 GITHUB_RUN_ATTEMPT=1
first_tag="${GITHUB_SHA:0:12}-$(printf '%s:%s' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" | sha256sum | cut -c1-12)"

TEST_UPLOAD_FAIL=false bash "$SCRIPT_DIR/deploy-standalone.sh"
[[ "$(grep -c 'ssh .* bash -s --' "$TEST_CALLS")" == 1 ]]
grep -Fq 'sha256sum --check --status' "$TEST_CALLS"
grep -Fq -- '--strip-components=1' "$TEST_CALLS"
grep -Fq "$first_tag" "$TEST_CALLS"
grep -Fq 'python3 deploy/standalone/blue-green.py "$release_action" --tag "$release_tag"' "$TEST_CALLS"
echo 'PASS: successful upload proceeds to archive verification and deployment'

: > "$TEST_CALLS"
TEST_UPLOAD_FAIL=true bash "$SCRIPT_DIR/deploy-standalone.sh"
[[ "$(grep -c 'ssh .* bash -s --' "$TEST_CALLS")" == 2 ]]
grep -Fq 'bash -s -- https://codeload.github.com/12456756/SEP/tar.gz/' "$TEST_CALLS"
grep -Fq 'curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$1" -o "$2"' "$TEST_CALLS"
grep -Fq 'sha256sum --check --status' "$TEST_CALLS"
echo 'PASS: slow or failed upload switches to server download before checksum verification'

: > "$TEST_CALLS"
GITHUB_RUN_ATTEMPT=2 TEST_UPLOAD_FAIL=false bash "$SCRIPT_DIR/deploy-standalone.sh"
second_tag="${GITHUB_SHA:0:12}-$(printf '%s:2' "$GITHUB_RUN_ID" | sha256sum | cut -c1-12)"
[[ "$first_tag" != "$second_tag" ]]
grep -Fq "$second_tag" "$TEST_CALLS"
echo 'PASS: a rerun uses a new immutable artifact tag without overwriting the first attempt'

: > "$TEST_CALLS"
if GITHUB_RUN_ATTEMPT=invalid bash "$SCRIPT_DIR/deploy-standalone.sh"; then exit 1; fi
[[ ! -s "$TEST_CALLS" ]]
echo 'PASS: invalid attempt metadata is rejected before network activity'

: > "$TEST_CALLS"
if GITHUB_REPOSITORY=unexpected/repository bash "$SCRIPT_DIR/deploy-standalone.sh"; then exit 1; fi
[[ ! -s "$TEST_CALLS" ]]
echo 'PASS: unexpected source repository is rejected before network activity'

: > "$TEST_CALLS"
if SEP_DEPLOY_ACTION=stage bash "$SCRIPT_DIR/deploy-standalone.sh"; then exit 1; fi
[[ ! -s "$TEST_CALLS" ]]
echo 'PASS: final migration requires a successful rehearsal tag'

: > "$TEST_CALLS"
SEP_DEPLOY_ACTION=rollback SEP_DEPLOY_TAG="$first_tag" bash "$SCRIPT_DIR/deploy-standalone.sh"
grep -Fq "$first_tag rollback" "$TEST_CALLS"
! grep -q '^curl\|^timeout' "$TEST_CALLS"
grep -Fq 'source = Path(state' "$TEST_CALLS"
echo 'PASS: rollback targets the original artifact without depending on a new attempt tag'

: > "$TEST_CALLS"
GITHUB_SHA=1111111111111111111111111111111111111111 SEP_DEPLOY_ACTION=rollback SEP_DEPLOY_TAG="$first_tag" bash "$SCRIPT_DIR/deploy-standalone.sh"
grep -Fq "$first_tag rollback" "$TEST_CALLS"
echo 'PASS: rollback remains available after main advances to a different commit'

: > "$TEST_CALLS"
if SEP_DEPLOY_ACTION=stage SEP_DEPLOY_TAG=111111111111 bash "$SCRIPT_DIR/deploy-standalone.sh"; then exit 1; fi
[[ ! -s "$TEST_CALLS" ]]
echo 'PASS: a tag from another commit is rejected before network activity'
