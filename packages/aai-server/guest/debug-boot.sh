#!/usr/bin/env bash
# Debug Firecracker VM boot issues step by step.
# Run inside the Docker container:
#   docker run --rm --device /dev/kvm --privileged -it aai-firecracker-test bash
#   bash packages/aai-server/guest/debug-boot.sh
set -euo pipefail

GUEST_DIST="packages/aai-server/guest/dist"
VMLINUX="${GUEST_DIST}/vmlinux"
INITRD="${GUEST_DIST}/initrd.cpio.gz"
TMPDIR=$(mktemp -d)
API_SOCK="${TMPDIR}/fc-api.sock"
VSOCK_PATH="${TMPDIR}/fc-vsock.sock"
CID=42

echo "=== Step 1: Check artifacts ==="
echo "vmlinux: $(ls -lh "$VMLINUX" 2>&1 || echo 'MISSING')"
echo "initrd:  $(ls -lh "$INITRD" 2>&1 || echo 'MISSING')"
echo "firecracker: $(which firecracker 2>&1 || echo 'MISSING')"
echo "/dev/kvm: $(ls -l /dev/kvm 2>&1 || echo 'MISSING')"

echo ""
echo "=== Step 2: Inspect initrd contents ==="
mkdir -p "${TMPDIR}/initrd-inspect"
cd "${TMPDIR}/initrd-inspect"
zcat "$OLDPWD/$INITRD" | cpio -id 2>/dev/null
echo "Files in initrd:"
find . -type f | head -20
echo ""
echo "/init exists: $(test -f ./init && echo 'YES' || echo 'NO')"
echo "/init is executable: $(test -x ./init && echo 'YES' || echo 'NO')"
echo "/init file type: $(file ./init 2>&1 || echo 'unknown')"
echo "/app/harness.js exists: $(test -f ./app/harness.js && echo 'YES' || echo 'NO')"
if [ -f ./app/harness.js ]; then
  echo "/app/harness.js first line: $(head -1 ./app/harness.js)"
  echo "/app/harness.js size: $(wc -c < ./app/harness.js) bytes"
fi
cd "$OLDPWD"

echo ""
echo "=== Step 3: Test /init (node) runs ==="
if [ -f "${TMPDIR}/initrd-inspect/init" ]; then
  "${TMPDIR}/initrd-inspect/init" --version 2>&1 || echo "FAILED to run /init"
fi

echo ""
echo "=== Step 4: Boot Firecracker VM ==="
echo "Starting firecracker..."
firecracker --api-sock "$API_SOCK" &
FC_PID=$!
sleep 1

if [ ! -S "$API_SOCK" ]; then
  echo "FAILED: API socket did not appear"
  kill $FC_PID 2>/dev/null || true
  exit 1
fi
echo "API socket ready"

echo "Configuring VM..."
# Boot source
curl -s --unix-socket "$API_SOCK" -X PUT "http://localhost/boot-source" \
  -H "Content-Type: application/json" \
  -d "{
    \"kernel_image_path\": \"$(realpath "$VMLINUX")\",
    \"initrd_path\": \"$(realpath "$INITRD")\",
    \"boot_args\": \"console=ttyS0 reboot=k panic=1 pci=off init=/init -- /app/harness.js\"
  }" && echo " boot-source: OK" || echo " boot-source: FAILED"

# Machine config
curl -s --unix-socket "$API_SOCK" -X PUT "http://localhost/machine-config" \
  -H "Content-Type: application/json" \
  -d '{"vcpu_count": 1, "mem_size_mib": 128}' \
  && echo " machine-config: OK" || echo " machine-config: FAILED"

# Vsock
curl -s --unix-socket "$API_SOCK" -X PUT "http://localhost/vsock" \
  -H "Content-Type: application/json" \
  -d "{\"vsock_id\": \"1\", \"guest_cid\": ${CID}, \"uds_path\": \"${VSOCK_PATH}\"}" \
  && echo " vsock: OK" || echo " vsock: FAILED"

echo ""
echo "Starting VM..."
curl -s --unix-socket "$API_SOCK" -X PUT "http://localhost/actions" \
  -H "Content-Type: application/json" \
  -d '{"action_type": "InstanceStart"}' \
  && echo " InstanceStart: OK" || echo " InstanceStart: FAILED"

echo ""
echo "=== Step 5: Wait for vsock ==="
echo "Waiting up to 10s for vsock socket at ${VSOCK_PATH}..."
for i in $(seq 1 100); do
  if [ -S "${VSOCK_PATH}_${CID}" ] || [ -S "${VSOCK_PATH}" ]; then
    echo "vsock socket appeared after $((i * 100))ms"
    break
  fi
  sleep 0.1
done

echo ""
echo "Sockets in tmpdir:"
ls -la "${TMPDIR}/"

echo ""
echo "=== Step 6: Try connecting to vsock ==="
# Firecracker creates the UDS at {uds_path}_{guest_cid}
VSOCK_ACTUAL="${VSOCK_PATH}_${CID}"
if [ -S "$VSOCK_ACTUAL" ]; then
  echo "Connecting to $VSOCK_ACTUAL..."
  # Try to send a simple message
  echo '{"type":"ping"}' | timeout 3 socat - "UNIX-CONNECT:${VSOCK_ACTUAL}" 2>&1 || echo "socat not available or connection failed"
else
  echo "vsock socket not found at $VSOCK_ACTUAL"
  echo "Checking if VM is still running..."
  kill -0 $FC_PID 2>/dev/null && echo "VM process alive (PID $FC_PID)" || echo "VM process DEAD"
fi

echo ""
echo "=== Cleanup ==="
kill $FC_PID 2>/dev/null || true
wait $FC_PID 2>/dev/null || true
rm -rf "$TMPDIR"
echo "Done."
