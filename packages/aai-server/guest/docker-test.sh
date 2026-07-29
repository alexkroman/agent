#!/bin/sh
# Run gVisor integration tests in Docker. No KVM required.
#
# Uses the repo-wide test image (Dockerfile.test), which ships runsc —
# the same image CI uses, so local and CI runs can't drift apart.
#
# gVisor requires native x86_64 Linux. It CANNOT run under:
# - Docker Desktop on Apple Silicon (Rosetta emulation breaks syscall interception)
# - ARM64 Linux
#
# Works on:
# - Linux x86_64 (bare metal or VM)
# - Docker Desktop on Intel Mac
# - GitHub Actions ubuntu-latest
set -eu

IMAGE_NAME="aai-test"
DOCKERFILE="Dockerfile.test"

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  echo "ERROR: gVisor requires native x86_64. Current arch: $ARCH"
  echo "       On Apple Silicon, run these tests in CI (GitHub Actions)."
  echo "       Locally, use fake-vm integration tests instead:"
  echo "       pnpm --filter aai-server test:integration"
  exit 1
fi

echo "Building test image..."
docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .
echo "Running gVisor integration tests..."
docker run --rm --privileged \
  -e CI=true \
  -e VITEST_PROFILE=gvisor \
  -e "VITEST_INCLUDE=packages/aai-server/gvisor-integration*.test.ts" \
  "$IMAGE_NAME" \
  pnpm vitest run -c vitest.slow.config.ts
