#!/bin/sh
# Run gVisor integration tests in Docker. No KVM required.
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

IMAGE_NAME="aai-gvisor-test"
DOCKERFILE="packages/aai-server/guest/Dockerfile.gvisor"

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  echo "ERROR: gVisor requires native x86_64. Current arch: $ARCH"
  echo "       On Apple Silicon, run these tests in CI (GitHub Actions)."
  echo "       Locally, use fake-vm integration tests instead:"
  echo "       pnpm vitest run packages/aai-server/fake-vm-integration.test.ts"
  exit 1
fi

echo "Building gVisor test image..."
docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .
echo "Running gVisor integration tests..."
docker run --rm --privileged "$IMAGE_NAME"
