// Copyright 2025 the AAI authors. MIT license.

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";

export type VmOptions = {
  vmlinuxPath: string;
  initrdPath: string;
  snapshotStatePath: string;
  snapshotMemPath: string;
  vcpuCount: number;
  memSizeMib: number;
  guestCid: number;
  vsockUdsPath: string;
};

export type ApiCall = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

export type FirecrackerVm = {
  process: ChildProcess;
  apiSocketPath: string;
  vsockUdsPath: string;
  guestCid: number;
  kill(): Promise<void>;
};

let firecrackerPath: string | null | undefined;

function findFirecracker(): string | null {
  if (firecrackerPath !== undefined) return firecrackerPath;
  try {
    firecrackerPath = execFileSync("which", ["firecracker"], {
      encoding: "utf-8",
    }).trim();
    return firecrackerPath;
  } catch {
    firecrackerPath = null;
    return null;
  }
}

/**
 * Returns true only on Linux when the `firecracker` binary is on PATH.
 */
export function isFirecrackerAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return findFirecracker() !== null;
}

/**
 * Pure function that generates the Firecracker REST API call sequence
 * for snapshot restore and VM start.
 */
export function buildVmConfig(opts: VmOptions): ApiCall[] {
  return [
    {
      method: "PUT",
      path: "/boot-source",
      body: {
        kernel_image_path: opts.vmlinuxPath,
        initrd_path: opts.initrdPath,
      },
    },
    {
      method: "PUT",
      path: "/machine-config",
      body: {
        vcpu_count: opts.vcpuCount,
        mem_size_mib: opts.memSizeMib,
      },
    },
    {
      method: "PUT",
      path: "/vsock",
      body: {
        vsock_id: "1",
        guest_cid: opts.guestCid,
        uds_path: opts.vsockUdsPath,
      },
    },
    {
      method: "PUT",
      path: "/snapshot/load",
      body: {
        snapshot_path: opts.snapshotStatePath,
        mem_backend: {
          backend_path: opts.snapshotMemPath,
        },
      },
    },
    {
      method: "PUT",
      path: "/actions",
      body: {
        action_type: "InstanceStart",
      },
    },
  ];
}

/**
 * Sends a single HTTP request to Firecracker's Unix socket API.
 */
async function apiCall(socketPath: string, call: ApiCall): Promise<void> {
  const body = JSON.stringify(call.body);

  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: call.path,
        method: call.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // Consume the response body to free the socket
        res.resume();
        res.on("end", () => {
          const { statusCode = 0 } = res;
          if (statusCode >= 200 && statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(`Firecracker API ${call.method} ${call.path} returned HTTP ${statusCode}`),
            );
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Polls for socket file existence with a 20ms interval.
 * Rejects if the socket does not appear within `timeout` ms.
 */
async function waitForSocket(socketPath: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  return new Promise<void>((resolve, reject) => {
    function check() {
      if (existsSync(socketPath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(`Firecracker API socket did not appear within ${timeout}ms: ${socketPath}`),
        );
        return;
      }
      setTimeout(check, 20);
    }
    check();
  });
}

/**
 * Spawns a Firecracker process, waits for the API socket to appear,
 * sends all config API calls, then returns a VM handle.
 *
 * On API error, kills the process and throws.
 */
export async function startVm(opts: VmOptions): Promise<FirecrackerVm> {
  const os = await import("node:os");
  const path = await import("node:path");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-fc-"));
  const apiSocketPath = path.join(tmpDir, "firecracker.sock");

  const fc = spawn("firecracker", ["--api-sock", apiSocketPath], {
    stdio: "ignore",
    detached: false,
  });

  async function killVm(): Promise<void> {
    fc.kill("SIGKILL");
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // Wait for Firecracker to create its API socket (up to 5 seconds)
  try {
    await waitForSocket(apiSocketPath, 5000);
  } catch (err) {
    await killVm();
    throw err;
  }

  // Send all configuration calls
  const calls = buildVmConfig(opts);
  for (const call of calls) {
    try {
      await apiCall(apiSocketPath, call);
    } catch (err) {
      await killVm();
      throw err;
    }
  }

  return {
    process: fc,
    apiSocketPath,
    vsockUdsPath: opts.vsockUdsPath,
    guestCid: opts.guestCid,
    kill: killVm,
  };
}
