#!/usr/bin/env bash
# Run tests inside a Linux Docker container.
#
# Usage:
#   ./scripts/docker-test.sh                           # pnpm test (all unit tests)
#   ./scripts/docker-test.sh pnpm check:local          # full local check
#   ./scripts/docker-test.sh pnpm vitest run --project aai-server  # single package
#   ./scripts/docker-test.sh bash                      # drop into shell for debugging
#
# The image caches aggressively — deps layer only rebuilds when
# package.json or lockfile changes. Code changes rebuild fast.

set -euo pipefail

IMAGE_NAME="aai-test"
DOCKERFILE="Dockerfile.test"

# Build (uses cache)
echo "Building test image..."
docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .

# Default command
CMD="${*:-pnpm test}"

echo "Running: $CMD"
docker run --rm \
  -e CI=true \
  "$IMAGE_NAME" \
  sh -c "$CMD"
