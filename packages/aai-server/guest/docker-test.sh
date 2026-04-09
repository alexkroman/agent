#!/bin/sh
# Run gVisor integration tests in Docker. No KVM required.
set -eu
IMAGE_NAME="aai-gvisor-test"
DOCKERFILE="packages/aai-server/guest/Dockerfile.gvisor"
echo "Building gVisor test image..."
docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .
echo "Running gVisor integration tests..."
docker run --rm --security-opt seccomp=unconfined "$IMAGE_NAME"
