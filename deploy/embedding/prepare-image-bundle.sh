#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
docker pull ollama/ollama:0.40.16
docker pull node:22-bookworm-slim
NODE_ID=$(docker image inspect node:22-bookworm-slim --format '{{.Id}}')
OLLAMA_DIGEST=$(docker image inspect ollama/ollama:0.40.16 --format '{{index .RepoDigests 0}}')
NODE_DIGEST=$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')
docker build --build-arg "OLLAMA_BASE_IMAGE=$OLLAMA_DIGEST" -f "$SOURCE/Dockerfile.cpu" -t sep-embedding/ollama-cpu:0.40.16 "$SOURCE"
OLLAMA_ID=$(docker image inspect sep-embedding/ollama-cpu:0.40.16 --format '{{.Id}}')
[[ "$OLLAMA_ID" =~ ^sha256:[a-f0-9]{64}$ && "$NODE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$OLLAMA_DIGEST" =~ ^ollama/ollama@sha256:[a-f0-9]{64}$ && "$NODE_DIGEST" =~ ^node@sha256:[a-f0-9]{64}$ ]]
OLLAMA_LOCAL="sep-embedding/ollama-cpu:0.40.16-${OLLAMA_ID#sha256:}"
NODE_LOCAL="sep-embedding/probe:22-${NODE_ID#sha256:}"
docker image tag sep-embedding/ollama-cpu:0.40.16 "$OLLAMA_LOCAL"
docker image tag node:22-bookworm-slim "$NODE_LOCAL"
printf 'OLLAMA_IMAGE=%s\nOLLAMA_IMAGE_ID=%s\nOLLAMA_SOURCE_DIGEST=%s\nPROBE_NODE_IMAGE=%s\nPROBE_NODE_IMAGE_ID=%s\nPROBE_NODE_SOURCE_DIGEST=%s\n' \
  "$OLLAMA_LOCAL" "$OLLAMA_ID" "$OLLAMA_DIGEST" "$NODE_LOCAL" "$NODE_ID" "$NODE_DIGEST" > "$SOURCE/.env"
ARCHIVE="${RUNNER_TEMP:?RUNNER_TEMP required}/sep-embedding-images.tar.gz"
docker save "$OLLAMA_LOCAL" "$NODE_LOCAL" | gzip -1 > "$ARCHIVE"
printf 'IMAGE_ARCHIVE=%s\n' "$ARCHIVE" >> "${GITHUB_ENV:?GITHUB_ENV required}"
printf 'Official Ollama: %s %s\nOfficial probe: %s %s\n' "$OLLAMA_DIGEST" "$OLLAMA_ID" "$NODE_DIGEST" "$NODE_ID"
sha256sum "$ARCHIVE"
