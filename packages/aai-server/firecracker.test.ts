// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { buildVmConfig, isFirecrackerAvailable } from "./firecracker.ts";

const TEST_OPTS = {
  vmlinuxPath: "/var/lib/firecracker/vmlinux",
  initrdPath: "/var/lib/firecracker/initrd.img",
  snapshotStatePath: "/var/lib/firecracker/snapshot.state",
  snapshotMemPath: "/var/lib/firecracker/snapshot.mem",
  vcpuCount: 1,
  memSizeMib: 128,
  guestCid: 42,
  vsockUdsPath: "/tmp/vsock-42.sock",
};

describe("buildVmConfig", () => {
  test("generates exactly 5 API calls in the correct order", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls).toHaveLength(5);

    const [boot, machine, vsock, snapshot, actions] = calls;

    expect(boot?.method).toBe("PUT");
    expect(boot?.path).toBe("/boot-source");

    expect(machine?.method).toBe("PUT");
    expect(machine?.path).toBe("/machine-config");

    expect(vsock?.method).toBe("PUT");
    expect(vsock?.path).toBe("/vsock");

    expect(snapshot?.method).toBe("PUT");
    expect(snapshot?.path).toBe("/snapshot/load");

    expect(actions?.method).toBe("PUT");
    expect(actions?.path).toBe("/actions");
  });

  test("boot-source contains kernel_image_path and initrd_path", () => {
    const [boot] = buildVmConfig(TEST_OPTS);
    expect(boot?.body).toEqual({
      kernel_image_path: "/var/lib/firecracker/vmlinux",
      initrd_path: "/var/lib/firecracker/initrd.img",
    });
  });

  test("machine-config contains vcpu_count and mem_size_mib", () => {
    const [, machine] = buildVmConfig(TEST_OPTS);
    expect(machine?.body).toEqual({
      vcpu_count: 1,
      mem_size_mib: 128,
    });
  });

  test("vsock contains vsock_id, guest_cid, and uds_path", () => {
    const [, , vsock] = buildVmConfig(TEST_OPTS);
    expect(vsock?.body).toEqual({
      vsock_id: "1",
      guest_cid: 42,
      uds_path: "/tmp/vsock-42.sock",
    });
  });

  test("snapshot/load contains snapshot_path and mem_backend with backend_path", () => {
    const [, , , snapshot] = buildVmConfig(TEST_OPTS);
    expect(snapshot?.body).toEqual({
      snapshot_path: "/var/lib/firecracker/snapshot.state",
      mem_backend: {
        backend_path: "/var/lib/firecracker/snapshot.mem",
      },
    });
  });

  test("actions contains action_type InstanceStart", () => {
    const [, , , , actions] = buildVmConfig(TEST_OPTS);
    expect(actions?.body).toEqual({
      action_type: "InstanceStart",
    });
  });

  test("uses values from opts (not hardcoded)", () => {
    const otherOpts = {
      ...TEST_OPTS,
      vmlinuxPath: "/other/vmlinux",
      initrdPath: "/other/initrd.img",
      snapshotStatePath: "/other/snap.state",
      snapshotMemPath: "/other/snap.mem",
      vcpuCount: 2,
      memSizeMib: 256,
      guestCid: 99,
      vsockUdsPath: "/tmp/vsock-99.sock",
    };

    const [boot, machine, vsock, snapshot] = buildVmConfig(otherOpts);

    expect(boot?.body).toMatchObject({
      kernel_image_path: "/other/vmlinux",
      initrd_path: "/other/initrd.img",
    });
    expect(machine?.body).toMatchObject({
      vcpu_count: 2,
      mem_size_mib: 256,
    });
    expect(vsock?.body).toMatchObject({
      guest_cid: 99,
      uds_path: "/tmp/vsock-99.sock",
    });
    expect(snapshot?.body).toMatchObject({
      snapshot_path: "/other/snap.state",
      mem_backend: { backend_path: "/other/snap.mem" },
    });
  });
});

describe("isFirecrackerAvailable", () => {
  test("returns false on non-Linux platforms", () => {
    if (process.platform === "linux") return;
    expect(isFirecrackerAvailable()).toBe(false);
  });

  test("returns a boolean", () => {
    expect(typeof isFirecrackerAvailable()).toBe("boolean");
  });
});
