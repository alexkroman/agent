// Copyright 2025 the AAI authors. MIT license.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type SnapshotPaths = {
  vmlinuxPath: string;
  initrdPath: string;
  snapshotStatePath: string;
  snapshotMemPath: string;
};

/**
 * Returns canonical paths for all Firecracker snapshot artifacts
 * rooted at baseDir.
 */
export function resolveSnapshotPaths(baseDir: string): SnapshotPaths {
  return {
    vmlinuxPath: path.join(baseDir, "vmlinux"),
    initrdPath: path.join(baseDir, "initrd.cpio"),
    snapshotStatePath: path.join(baseDir, "base.state"),
    snapshotMemPath: path.join(baseDir, "base.mem"),
  };
}

/**
 * Returns true when all snapshot artifacts exist and the initrd has not
 * been modified since the snapshot was taken.
 *
 * Returns false when:
 * - Any required file is missing
 * - The initrd is newer than the snapshot state (stale snapshot)
 */
export function isSnapshotValid(paths: SnapshotPaths): boolean {
  const { vmlinuxPath, initrdPath, snapshotStatePath, snapshotMemPath } = paths;

  // All four files must exist
  if (
    !(
      existsSync(vmlinuxPath) &&
      existsSync(initrdPath) &&
      existsSync(snapshotStatePath) &&
      existsSync(snapshotMemPath)
    )
  ) {
    return false;
  }

  // Snapshot is stale if initrd was modified after the snapshot was taken
  const initrdMtime = statSync(initrdPath).mtimeMs;
  const snapshotMtime = statSync(snapshotStatePath).mtimeMs;
  if (initrdMtime > snapshotMtime) {
    return false;
  }

  return true;
}

/**
 * Boots a fresh Firecracker VM (cold boot, no snapshot restore),
 * waits for the guest to signal "ready" over vsock, pauses the VM,
 * takes a snapshot, and cleans up.
 *
 * The resulting snapshot files are written to the paths specified in `paths`.
 *
 * TODO(cold-boot): Implement full cold boot + snapshot creation sequence.
 * The Firecracker API calls needed are:
 *   PUT /boot-source   — kernel + initrd
 *   PUT /machine-config — vcpu / mem
 *   PUT /vsock         — vsock device
 *   PUT /actions { action_type: "InstanceStart" }  — start VM (no snapshot/load)
 *   [wait for guest "ready" signal over vsock]
 *   PATCH /vm { state: "Paused" }
 *   PUT /snapshot/create { snapshot_type: "Full", snapshot_path, mem_file_path }
 *
 * This requires a real Firecracker binary to test against. Verify against
 * the Docker integration test (Task 12b) before removing this TODO.
 */
export async function buildBaseSnapshot(_paths: SnapshotPaths): Promise<void> {
  // TODO(cold-boot): cold boot the VM, wait for guest ready signal over vsock,
  // pause and snapshot using the Firecracker REST API, then kill the VM.
  // See function JSDoc for the full API call sequence.
  throw new Error(
    "buildBaseSnapshot: cold boot path not yet implemented — requires a real Firecracker binary",
  );
}
