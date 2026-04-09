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

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/boot-source");

    expect(calls[1].method).toBe("PUT");
    expect(calls[1].path).toBe("/machine-config");

    expect(calls[2].method).toBe("PUT");
    expect(calls[2].path).toBe("/vsock");

    expect(calls[3].method).toBe("PUT");
    expect(calls[3].path).toBe("/snapshot/load");

    expect(calls[4].method).toBe("PUT");
    expect(calls[4].path).toBe("/actions");
  });

  test("boot-source contains kernel_image_path and initrd_path", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls[0].body).toEqual({
      kernel_image_path: "/var/lib/firecracker/vmlinux",
      initrd_path: "/var/lib/firecracker/initrd.img",
    });
  });

  test("machine-config contains vcpu_count and mem_size_mib", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls[1].body).toEqual({
      vcpu_count: 1,
      mem_size_mib: 128,
    });
  });

  test("vsock contains vsock_id, guest_cid, and uds_path", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls[2].body).toEqual({
      vsock_id: "1",
      guest_cid: 42,
      uds_path: "/tmp/vsock-42.sock",
    });
  });

  test("snapshot/load contains snapshot_path and mem_backend with backend_path", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls[3].body).toEqual({
      snapshot_path: "/var/lib/firecracker/snapshot.state",
      mem_backend: {
        backend_path: "/var/lib/firecracker/snapshot.mem",
      },
    });
  });

  test("actions contains action_type InstanceStart", () => {
    const calls = buildVmConfig(TEST_OPTS);
    expect(calls[4].body).toEqual({
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

    const calls = buildVmConfig(otherOpts);

    expect(calls[0].body).toMatchObject({
      kernel_image_path: "/other/vmlinux",
      initrd_path: "/other/initrd.img",
    });
    expect(calls[1].body).toMatchObject({
      vcpu_count: 2,
      mem_size_mib: 256,
    });
    expect(calls[2].body).toMatchObject({
      guest_cid: 99,
      uds_path: "/tmp/vsock-99.sock",
    });
    expect(calls[3].body).toMatchObject({
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
