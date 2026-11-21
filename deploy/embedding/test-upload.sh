#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/deploy/embedding" "$TEMP/deploy/standalone"
cp "$SOURCE/upload.sh" "$SOURCE/compose.yaml" "$SOURCE/compose.production.yaml" "$SOURCE/manage.sh" "$SOURCE/verify-embedding.cjs" "$TEMP/deploy/embedding/"
printf 'mock non-secret image pins\n' > "$TEMP/deploy/embedding/.env"
printf 'mock archive bytes\n' > "$TEMP/images.tar.gz"
export IMAGE_ARCHIVE="$TEMP/images.tar.gz"
SOURCE="$TEMP/deploy/embedding"
mkdir -p "$TEMP/bin"
export CALLS="$TEMP/calls"
cat > "$TEMP/bin/mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
name=${0##*/}
printf '%s %s\n' "$name" "$*" >> "$CALLS"
if [[ "$name" == ssh ]]; then cat >> "$CALLS"; fi
if [[ "$name" == timeout ]]; then [[ "${MOCK_UPLOAD_FAIL:-false}" != true ]]; fi
if [[ "$name" == node ]]; then printf 'https://example.invalid/mock-only-artifact'; fi
MOCK
chmod +x "$TEMP/bin/mock"
for name in ssh scp timeout node; do ln -s mock "$TEMP/bin/$name"; done
export PATH="$TEMP/bin:$PATH"
export GITHUB_SHA=9309ea6b09659538d06fdfae5f5edac3b047b4fb GITHUB_REPOSITORY=12456756/SEP GITHUB_REF=refs/heads/main
export SERVER_HOST=121.37.128.126 SERVER_PORT=22 SERVER_USER=root SERVER_SSH_KEY=mock-only
for action in status verify stop; do
  : > "$CALLS"
  EMBEDDING_ACTION="$action" bash "$SOURCE/upload.sh"
  ! grep -q '^scp ' "$CALLS"
  ! grep -q 'install -d\|tar -x\|docker pull' "$CALLS"
done
echo 'PASS: status/verify/stop do not upload or overwrite independent deployment files'
: > "$CALLS"
EMBEDDING_ACTION=install bash "$SOURCE/upload.sh"
grep -q '^scp ' "$CALLS"
grep -Fq '/www/sep-embedding/releases/' "$CALLS"
grep -Fq 'sha256sum --check --status' "$CALLS"
! grep -Fq '/www/sep/deploy' "$CALLS"
echo 'PASS: install only transfers a checksummed model service bundle'
: > "$CALLS"
MOCK_UPLOAD_FAIL=true RUNTIME_ARTIFACT_ID=123 GITHUB_TOKEN=mock-only EMBEDDING_ACTION=install bash "$SOURCE/upload.sh"
grep -Fq 'runtime-artifact.zip' "$CALLS"
grep -Fq 'Unexpected runtime artifact contents' "$CALLS"
grep -Fq 'image_checksum' "$CALLS"
echo 'PASS: slow runtime upload falls back to the same authenticated Actions artifact and checksum verification'
for input in wrong-operation wrong-repository wrong-branch wrong-server; do
  : > "$CALLS"
  case "$input" in
    wrong-operation) if EMBEDDING_ACTION=bad bash "$SOURCE/upload.sh"; then exit 1; fi ;;
    wrong-repository) if GITHUB_REPOSITORY=other/repo bash "$SOURCE/upload.sh"; then exit 1; fi ;;
    wrong-branch) if GITHUB_REF=refs/heads/test bash "$SOURCE/upload.sh"; then exit 1; fi ;;
    wrong-server) if SERVER_HOST=127.0.0.1 bash "$SOURCE/upload.sh"; then exit 1; fi ;;
  esac
  [[ ! -s "$CALLS" ]]
done
echo 'PASS: invalid operations and targets fail before network activity'
