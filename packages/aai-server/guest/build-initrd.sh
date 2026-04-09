#!/usr/bin/env bash
# Build initrd.cpio with static Node.js + harness.
# Usage: ./build-initrd.sh [output-dir] [harness-path]
#
# Produces initrd.cpio.gz in output-dir (default: ./out).
# harness-path defaults to ./harness.js (relative to this script).
#
# NOTE: A statically-linked Node.js binary is required. Standard Node.js
# binaries dynamically link against glibc and will not work as PID 1 in a
# minimal initrd environment. You need a Node.js binary built with
# --fully-static against musl libc (e.g. from an unofficial musl-static
# distribution or built from source with:
#   ./configure --fully-static && make -j$(nproc)
# against a musl-based toolchain). Place the static binary at NODE_BINARY
# or pass the path via the NODE_BINARY environment variable.
#
# Requirements (host):
#   - cpio, gzip
#   - mknod (requires root or CAP_MKNOD for device nodes)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/out}"
HARNESS_PATH="${2:-${SCRIPT_DIR}/harness.js}"
NODE_BINARY="${NODE_BINARY:-/usr/local/bin/node-static}"

echo "==> Output dir:   ${OUTPUT_DIR}"
echo "==> Harness:      ${HARNESS_PATH}"
echo "==> Node binary:  ${NODE_BINARY}"

# Validate inputs
if [[ ! -f "${NODE_BINARY}" ]]; then
  echo "ERROR: Static Node.js binary not found at: ${NODE_BINARY}" >&2
  echo "       Set NODE_BINARY env var to the path of a statically-linked node." >&2
  echo "       See the comment at the top of this script for build instructions." >&2
  exit 1
fi

if [[ ! -f "${HARNESS_PATH}" ]]; then
  echo "ERROR: harness.js not found at: ${HARNESS_PATH}" >&2
  echo "       Build the harness first (pnpm build in packages/aai-server)." >&2
  exit 1
fi

# Verify the node binary is actually static
if command -v ldd &>/dev/null; then
  if ldd "${NODE_BINARY}" 2>&1 | grep -qv 'not a dynamic executable'; then
    echo "WARNING: ${NODE_BINARY} may not be statically linked." >&2
    echo "         A dynamically linked binary will fail as PID 1 in a minimal initrd." >&2
  fi
fi

mkdir -p "${OUTPUT_DIR}"

# Create a temp directory for the initrd filesystem tree
INITRD_ROOT="$(mktemp -d /tmp/firecracker-initrd.XXXXXX)"
trap 'rm -rf "${INITRD_ROOT}"' EXIT

echo "==> Building initrd filesystem in ${INITRD_ROOT}..."

# Create directory structure
mkdir -p "${INITRD_ROOT}/app"
mkdir -p "${INITRD_ROOT}/dev"
mkdir -p "${INITRD_ROOT}/tmp"

# Copy static Node.js binary as /init (PID 1)
# The kernel executes /init after mounting the initramfs.
echo "==> Copying node binary as /init..."
cp "${NODE_BINARY}" "${INITRD_ROOT}/init"
chmod 755 "${INITRD_ROOT}/init"

# Copy harness.js — /init (node) will exec this as its entry point
# The guest kernel passes /app/harness.js as argv[1] via the kernel cmdline
# (append="-- /app/harness.js") or the init reads it from a fixed path.
echo "==> Copying harness.js..."
cp "${HARNESS_PATH}" "${INITRD_ROOT}/app/harness.js"
chmod 644 "${INITRD_ROOT}/app/harness.js"

# Create essential device nodes
# These require root (mknod). In CI, run this script as root or with CAP_MKNOD.
echo "==> Creating device nodes (requires root)..."

# /dev/null — character device 1:3
mknod -m 666 "${INITRD_ROOT}/dev/null"    c 1 3

# /dev/urandom — character device 1:9
mknod -m 444 "${INITRD_ROOT}/dev/urandom" c 1 9

# /dev/console — character device 5:1 (for serial console output)
mknod -m 600 "${INITRD_ROOT}/dev/console" c 5 1

# /dev/vsock — character device 10:238 (AF_VSOCK)
mknod -m 600 "${INITRD_ROOT}/dev/vsock"   c 10 238

# Pack as gzipped cpio archive
# Using newc format (the only format supported by the Linux kernel initramfs).
OUTPUT_CPIO="${OUTPUT_DIR}/initrd.cpio.gz"
echo "==> Packing cpio archive..."
(
  cd "${INITRD_ROOT}"
  find . | cpio --quiet -H newc -o | gzip -9 > "${OUTPUT_CPIO}"
)

echo "==> Done. initrd.cpio.gz: ${OUTPUT_CPIO} ($(du -sh "${OUTPUT_CPIO}" | cut -f1))"
