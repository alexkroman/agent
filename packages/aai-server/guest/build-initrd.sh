#!/bin/sh
# Build initrd.cpio with Node.js + harness for Firecracker guests.
# Usage: ./build-initrd.sh [output-dir] [harness-path]
#
# Produces initrd.cpio.gz in output-dir (default: ./out).
#
# The Node.js binary (NODE_BINARY env var or /usr/local/bin/node) and its
# dynamic libraries are copied into the initrd. On Alpine, this produces
# a musl-linked guest. The initrd also includes busybox for /bin/sh and
# socat for bridging AF_VSOCK to node's stdio.
#
# Requirements:
#   - cpio, gzip
#   - Node.js binary (musl-linked, e.g. from Alpine)
#   - busybox (optional but recommended for /init shell script)
#   - socat (required for vsock ↔ stdio bridge in Firecracker guests)

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-${SCRIPT_DIR}/out}"
HARNESS_PATH="${2:-${SCRIPT_DIR}/harness.mjs}"
NODE_BINARY="${NODE_BINARY:-/usr/local/bin/node}"

echo "==> Output dir:   ${OUTPUT_DIR}"
echo "==> Harness:      ${HARNESS_PATH}"
echo "==> Node binary:  ${NODE_BINARY}"

# Validate inputs
if [ ! -f "${NODE_BINARY}" ]; then
  echo "ERROR: Node.js binary not found at: ${NODE_BINARY}" >&2
  exit 1
fi

if [ ! -f "${HARNESS_PATH}" ]; then
  echo "ERROR: harness not found at: ${HARNESS_PATH}" >&2
  echo "       Build the harness first (pnpm build in packages/aai-server)." >&2
  exit 1
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
mkdir -p "${INITRD_ROOT}/lib"
mkdir -p "${INITRD_ROOT}/usr/lib"
mkdir -p "${INITRD_ROOT}/bin"
mkdir -p "${INITRD_ROOT}/proc"

# Copy Node.js binary
echo "==> Copying node binary..."
cp "${NODE_BINARY}" "${INITRD_ROOT}/bin/node"
chmod 755 "${INITRD_ROOT}/bin/node"

# Copy busybox (provides /bin/sh, mount, etc.)
if command -v busybox >/dev/null 2>&1; then
  echo "==> Copying busybox..."
  cp "$(command -v busybox)" "${INITRD_ROOT}/bin/busybox"
  chmod 755 "${INITRD_ROOT}/bin/busybox"
  # Create symlinks for essential commands
  for cmd in sh mount umount mkdir cat ls; do
    ln -sf busybox "${INITRD_ROOT}/bin/${cmd}"
  done
else
  echo "WARNING: busybox not found — /init script needs /bin/sh" >&2
fi

# Copy socat (provides vsock ↔ stdio bridge)
if command -v socat >/dev/null 2>&1; then
  echo "==> Copying socat..."
  cp "$(command -v socat)" "${INITRD_ROOT}/bin/socat"
  chmod 755 "${INITRD_ROOT}/bin/socat"
else
  echo "WARNING: socat not found — vsock bridge will not work in Firecracker" >&2
fi

# Copy dynamic libraries needed by Node.js (musl from Alpine)
echo "==> Copying shared libraries..."
for lib in /lib/ld-musl-* /lib/libz.* /usr/lib/libstdc++.* /usr/lib/libgcc_s.*; do
  if [ -e "$lib" ]; then
    destdir="${INITRD_ROOT}/$(dirname "$lib")"
    mkdir -p "$destdir"
    cp "$lib" "$destdir/"
    echo "    $(basename "$lib")"
  fi
done

# Create /init script — the kernel executes this as PID 1.
# Uses socat to listen on AF_VSOCK port 1024 and bridge the accepted
# connection to node's stdin/stdout. The host connects to the vsock UDS,
# sends "CONNECT 1024\n", Firecracker forwards to the guest, and socat
# accepts the connection — giving node a bidirectional byte stream.
cat > "${INITRD_ROOT}/init" << 'INIT_EOF'
#!/bin/sh
/bin/mount -t proc proc /proc 2>/dev/null || true
/bin/mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
exec /bin/socat VSOCK-LISTEN:1024,reuseaddr EXEC:"/bin/node /app/harness.mjs"
INIT_EOF
chmod 755 "${INITRD_ROOT}/init"

# Copy harness
echo "==> Copying harness..."
cp "${HARNESS_PATH}" "${INITRD_ROOT}/app/harness.mjs"
chmod 644 "${INITRD_ROOT}/app/harness.mjs"

# Create device nodes if we can (kernel needs /dev/console before init).
# devtmpfs mounted by /init handles the rest.
if [ "$(id -u)" = "0" ]; then
  echo "==> Creating device nodes..."
  mknod -m 666 "${INITRD_ROOT}/dev/null"    c 1 3
  mknod -m 444 "${INITRD_ROOT}/dev/urandom" c 1 9
  mknod -m 600 "${INITRD_ROOT}/dev/console" c 5 1
else
  echo "==> Skipping mknod (not root). devtmpfs will provide devices at boot."
fi

# Pack as gzipped cpio archive (newc format required by Linux initramfs)
OUTPUT_CPIO="${OUTPUT_DIR}/initrd.cpio.gz"
echo "==> Packing cpio archive..."
(
  cd "${INITRD_ROOT}"
  find . | cpio --quiet -H newc -o | gzip -9 > "${OUTPUT_CPIO}"
)

echo "==> Done. initrd.cpio.gz: ${OUTPUT_CPIO} ($(du -sh "${OUTPUT_CPIO}" | cut -f1))"
