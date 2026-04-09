#!/usr/bin/env bash
# Build a minimal Linux kernel for Firecracker guests.
# Usage: ./build-kernel.sh [output-dir]
#
# Produces vmlinux in output-dir (default: ./out).
# Caches the Linux source tarball in /tmp to speed up repeated builds.
#
# Requirements:
#   - gcc, make, bc, flex, bison, libssl-dev (or openssl-devel)
#   - wget or curl

set -euo pipefail

KERNEL_VERSION="6.1.130"
KERNEL_MAJOR="6"
KERNEL_ARCHIVE="linux-${KERNEL_VERSION}.tar.xz"
KERNEL_URL="https://cdn.kernel.org/pub/linux/kernel/v${KERNEL_MAJOR}.x/${KERNEL_ARCHIVE}"
KERNEL_CACHE_DIR="${TMPDIR:-/tmp}/firecracker-kernel-cache"
OUTPUT_DIR="${1:-$(dirname "$0")/out}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/kernel.config"

echo "==> Kernel version: ${KERNEL_VERSION}"
echo "==> Output dir:     ${OUTPUT_DIR}"

mkdir -p "${KERNEL_CACHE_DIR}" "${OUTPUT_DIR}"

# Download kernel source if not already cached
TARBALL="${KERNEL_CACHE_DIR}/${KERNEL_ARCHIVE}"
if [[ ! -f "${TARBALL}" ]]; then
  echo "==> Downloading Linux ${KERNEL_VERSION}..."
  if command -v wget &>/dev/null; then
    wget -q --show-progress -O "${TARBALL}" "${KERNEL_URL}"
  elif command -v curl &>/dev/null; then
    curl -L --progress-bar -o "${TARBALL}" "${KERNEL_URL}"
  else
    echo "ERROR: wget or curl is required to download the kernel source." >&2
    exit 1
  fi
else
  echo "==> Using cached tarball: ${TARBALL}"
fi

# Extract source into cache dir if needed
KERNEL_SRC="${KERNEL_CACHE_DIR}/linux-${KERNEL_VERSION}"
if [[ ! -d "${KERNEL_SRC}" ]]; then
  echo "==> Extracting kernel source..."
  tar -xf "${TARBALL}" -C "${KERNEL_CACHE_DIR}"
fi

# Apply our minimal config
echo "==> Applying kernel.config..."
cp "${CONFIG_FILE}" "${KERNEL_SRC}/.config"

# Resolve any new symbols introduced since the config was last generated
echo "==> Running olddefconfig..."
make -C "${KERNEL_SRC}" olddefconfig

# Build vmlinux (not the full bzImage — Firecracker accepts vmlinux directly)
NPROC="${NPROC:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
echo "==> Building vmlinux with ${NPROC} jobs..."
make -C "${KERNEL_SRC}" vmlinux -j"${NPROC}"

# Copy output
echo "==> Copying vmlinux to ${OUTPUT_DIR}..."
cp "${KERNEL_SRC}/vmlinux" "${OUTPUT_DIR}/vmlinux"

echo "==> Done. vmlinux: ${OUTPUT_DIR}/vmlinux ($(du -sh "${OUTPUT_DIR}/vmlinux" | cut -f1))"
