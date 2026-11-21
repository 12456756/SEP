#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/bin" "$TEMP/source"
cp "$SOURCE/prepare-image-bundle.sh" "$TEMP/source/"
export BUNDLE_CALLS="$TEMP/calls"
cat > "$TEMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BUNDLE_CALLS"
case "$1 $2" in
  'image inspect')
    if [[ "$*" == *RepoDigests* ]]; then
      if [[ "$3" == ollama/* ]]; then printf 'ollama/ollama@sha256:%064d\n' 1; else printf 'node@sha256:%064d\n' 2; fi
    else
      printf 'sha256:%064d\n' 3
    fi
    ;;
  'save '*) printf 'mock docker export stream' ;;
esac
MOCK
chmod +x "$TEMP/bin/docker"
export PATH="$TEMP/bin:$PATH" RUNNER_TEMP="$TEMP" GITHUB_ENV="$TEMP/github-env"
bash "$TEMP/source/prepare-image-bundle.sh"
grep -Eq '^OLLAMA_IMAGE=sep-embedding/ollama:0\.40\.16-[a-f0-9]{64}$' "$TEMP/source/.env"
grep -Eq '^PROBE_NODE_IMAGE=sep-embedding/probe:22-[a-f0-9]{64}$' "$TEMP/source/.env"
grep -Fq 'pull ollama/ollama:0.40.16' "$BUNDLE_CALLS"
grep -Fq 'save sep-embedding/ollama:' "$BUNDLE_CALLS"
[[ -s "$TEMP/sep-embedding-images.tar.gz" ]]
gzip -t "$TEMP/sep-embedding-images.tar.gz"
echo 'PASS: official image digests and IDs recorded; unique tags exported in a valid archive'
