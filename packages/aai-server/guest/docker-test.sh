#!/usr/bin/env bash
# Run Firecracker integration tests in Docker with KVM.
#
# Usage: ./docker-test.sh
#
# Requires:
#   - Docker
#   - /dev/kvm on host (Linux only — will not work on macOS Docker Desktop)
#
# The first run builds the guest kernel (~10-30 min). Subsequent runs use
# Docker layer cache and are much faster unless kernel.config changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
IMAGE_NAME="aai-firecracker-test"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile.firecracker"

# ── Pre-flight checks ────────────────────────────────────────────────────────

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: Firecracker requires KVM, which is only available on Linux." >&2
  echo "       macOS Docker Desktop does not support /dev/kvm passthrough." >&2
  exit 1
fi

if [[ ! -e /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found." >&2
  echo "       Ensure KVM is enabled:" >&2
  echo "         sudo modprobe kvm" >&2
  echo "         sudo modprobe kvm_intel  # or kvm_amd" >&2
  echo "       And that your user has access:" >&2
  echo "         sudo usermod -aG kvm \$(whoami)" >&2
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running." >&2
  exit 1
fi

# ── Build the Docker image ───────────────────────────────────────────────────

echo "==> Building Firecracker test image (this may take a while on first run)..."
echo "    Image:      ${IMAGE_NAME}"
echo "    Dockerfile: ${DOCKERFILE}"
echo "    Context:    ${REPO_ROOT}"
echo ""

docker build \
  -f "${DOCKERFILE}" \
  -t "${IMAGE_NAME}" \
  "${REPO_ROOT}"

echo ""
echo "==> Image built successfully."
echo ""

# ── Run the integration tests ────────────────────────────────────────────────

echo "==> Running Firecracker integration tests..."
echo ""

docker run \
  --rm \
  --device /dev/kvm \
  --privileged \
  "${IMAGE_NAME}"

EXIT_CODE=$?

echo ""
if [[ ${EXIT_CODE} -eq 0 ]]; then
  echo "==> All Firecracker integration tests passed."
else
  echo "==> Firecracker integration tests FAILED (exit code: ${EXIT_CODE})."
fi

exit ${EXIT_CODE}
