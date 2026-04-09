// Copyright 2025 the AAI authors. MIT license.
/**
 * Firecracker microVM integration tests.
 *
 * Tests the full VM lifecycle: boot, vsock connectivity, snapshot create/restore,
 * bundle injection, tool execution, KV round-trip, cross-agent isolation,
 * filesystem isolation, network isolation, and shutdown.
 *
 * These tests require:
 *   - Linux with /dev/kvm
 *   - Firecracker binary on PATH
 *   - Built guest artifacts in packages/aai-server/guest/dist/
 *     (vmlinux, initrd.cpio.gz)
 *
 * Run via Docker:
 *   ./packages/aai-server/guest/docker-test.sh
 *
 * Or directly on a Linux host with KVM:
 *   pnpm --filter @alexkroman1/aai-server exec vitest run --config vitest.firecracker.config.ts
 */

import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type FirecrackerVm, isFirecrackerAvailable } from "./firecracker.ts";
import { createRpcChannel, type RpcChannel } from "./vsock.ts";

// ── Paths to guest artifacts ────────────────────────────────────────────────

const GUEST_DIST = path.resolve(import.meta.dirname, "guest/dist");
const VMLINUX_PATH = path.join(GUEST_DIST, "vmlinux");
const INITRD_PATH = path.join(GUEST_DIST, "initrd.cpio.gz");

// Snapshot paths (created by the snapshot test, used by subsequent tests)
const SNAPSHOT_STATE_PATH = path.join(GUEST_DIST, "base.state");
const SNAPSHOT_MEM_PATH = path.join(GUEST_DIST, "base.mem");

// ── Helpers ─────────────────────────────────────────────────────────────────

function guestArtifactsExist(): boolean {
  return existsSync(VMLINUX_PATH) && existsSync(INITRD_PATH);
}

/** Unique CID counter to avoid collisions between concurrent VMs. */
let cidCounter = 100;
function nextCid(): number {
  return cidCounter++;
}

/** Temporary directory for VM sockets and artifacts. */
let tmpDir: string;

/** Track all VMs started during tests for cleanup. */
const activeVms: FirecrackerVm[] = [];

/**
 * Sends a single HTTP request to Firecracker's Unix socket API.
 * Used for cold boot and snapshot operations not covered by startVm().
 */
async function firecrackerApi(
  socketPath: string,
  method: string,
  apiPath: string,
  body: Record<string, unknown>,
): Promise<void> {
  const bodyStr = JSON.stringify(body);
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: apiPath,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          const { statusCode = 0 } = res;
          if (statusCode >= 200 && statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Firecracker API ${method} ${apiPath} returned HTTP ${statusCode}: ${data}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Polls for socket file existence with a 50ms interval.
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
        reject(new Error(`Socket did not appear within ${timeout}ms: ${socketPath}`));
        return;
      }
      setTimeout(check, 50);
    }
    check();
  });
}

/**
 * Cold-boots a Firecracker VM (no snapshot). Returns the process, API socket,
 * and vsock UDS path. The VM is NOT started yet — callers must send the
 * InstanceStart action after configuring the VM.
 */
async function coldBootVm(opts: { guestCid: number; vsockUdsPath: string }): Promise<{
  process: ReturnType<typeof import("node:child_process").spawn>;
  apiSocketPath: string;
}> {
  const { spawn } = await import("node:child_process");
  const apiSocketPath = path.join(tmpDir, `fc-api-${opts.guestCid}.sock`);

  const fc = spawn("firecracker", ["--api-sock", apiSocketPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Capture Firecracker stdout/stderr for debugging boot issues
  let fcOutput = "";
  fc.stdout?.on("data", (chunk: Buffer) => {
    fcOutput += chunk.toString();
  });
  fc.stderr?.on("data", (chunk: Buffer) => {
    fcOutput += chunk.toString();
  });
  fc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[FC cid=${opts.guestCid}] exited with code ${code}`);
      console.error(`[FC cid=${opts.guestCid}] output:\n${fcOutput.slice(-2000)}`);
    }
  });

  activeVms.push({
    process: fc,
    apiSocketPath,
    vsockUdsPath: opts.vsockUdsPath,
    guestCid: opts.guestCid,
    kill: async () => {
      fc.kill("SIGKILL");
    },
  });

  // Wait for API socket
  await waitForSocket(apiSocketPath, 5000);

  // Configure VM for cold boot (no snapshot/load)
  await firecrackerApi(apiSocketPath, "PUT", "/boot-source", {
    kernel_image_path: VMLINUX_PATH,
    initrd_path: INITRD_PATH,
    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/init",
  });

  await firecrackerApi(apiSocketPath, "PUT", "/machine-config", {
    vcpu_count: 1,
    mem_size_mib: 128,
  });

  await firecrackerApi(apiSocketPath, "PUT", "/vsock", {
    vsock_id: "1",
    guest_cid: opts.guestCid,
    uds_path: opts.vsockUdsPath,
  });

  return { process: fc, apiSocketPath };
}

/**
 * Connects to the guest over vsock UDS and creates an RPC channel.
 * Retries for up to `timeout` ms since the guest may take time to listen.
 */
/**
 * Performs the Firecracker vsock CONNECT handshake on an already-connected socket.
 * Sends `CONNECT <port>\n` and resolves when `OK <port>\n` is received.
 * Rejects if the handshake response is not OK.
 */
function performVsockHandshake(socket: net.Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`CONNECT ${port}\n`);

    let buf = "";
    function onData(chunk: Buffer) {
      buf += chunk.toString();
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx === -1) return; // Wait for full line

      const line = buf.slice(0, newlineIdx).trim();
      socket.removeListener("data", onData);

      if (line === `OK ${port}`) {
        // Push leftover data back so the RPC channel sees it
        const leftover = buf.slice(newlineIdx + 1);
        if (leftover.length > 0) {
          socket.unshift(Buffer.from(leftover));
        }
        resolve();
      } else {
        reject(new Error(`Vsock handshake failed: ${line}`));
      }
    }

    socket.on("data", onData);
  });
}

/**
 * Connects to the guest over vsock UDS and creates an RPC channel.
 * Retries for up to `timeout` ms since the guest may take time to listen.
 *
 * NOTE: Firecracker creates the vsock UDS at `{uds_path}_{guest_cid}`,
 * not at `{uds_path}`. The caller passes the base path and guest CID.
 *
 * After connecting to the UDS, sends the Firecracker vsock CONNECT
 * handshake: `CONNECT <port>\n`. Waits for `OK <port>\n` before
 * creating the RPC channel on the now-bridged byte stream.
 */
async function connectVsock(
  vsockUdsPath: string,
  _guestCid: number,
  timeout: number,
): Promise<{ socket: net.Socket; channel: RpcChannel }> {
  // Firecracker creates the vsock UDS at the exact configured path.
  // The guest CID is used in the CONNECT handshake, not the socket filename.
  const actualPath = vsockUdsPath;
  const VSOCK_PORT = 1024;
  const deadline = Date.now() + timeout;

  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() >= deadline) {
        // Log diagnostic info about what files exist in the socket directory
        const dir = path.dirname(actualPath);
        let files = "unknown";
        try {
          files = readdirSync(dir).join(", ");
        } catch {
          // directory may not exist
        }
        reject(
          new Error(
            `Could not connect to vsock within ${timeout}ms: ${actualPath}\n` +
              `  Files in ${dir}: [${files}]`,
          ),
        );
        return;
      }

      const socket = net.connect(actualPath, () => {
        performVsockHandshake(socket, VSOCK_PORT)
          .then(() => {
            const channel = createRpcChannel(socket as unknown as Duplex);
            resolve({ socket, channel });
          })
          .catch(() => {
            socket.destroy();
            // Retry — guest may not be listening on the vsock port yet
            setTimeout(tryConnect, 100);
          });
      });

      socket.on("error", () => {
        socket.destroy();
        // Retry after a short delay
        setTimeout(tryConnect, 100);
      });
    }

    tryConnect();
  });
}

// ── Simple agent bundles ────────────────────────────────────────────────────

const SIMPLE_AGENT_BUNDLE = `
module.exports = {
  default: {
    name: "test-agent",
    systemPrompt: "You are a test agent.",
    greeting: "Hello",
    maxSteps: 1,
    tools: {
      echo: {
        description: "Echo the input",
        execute(args) { return "echo:" + args.text; },
      },
    },
  },
};
`;

const KV_AGENT_BUNDLE = `
module.exports = {
  default: {
    name: "kv-agent",
    systemPrompt: "KV test agent.",
    greeting: "Hello",
    maxSteps: 1,
    tools: {
      kv_roundtrip: {
        description: "Store then read from KV",
        async execute(args, ctx) {
          await ctx.kv.set("test-key", args.value);
          const result = await ctx.kv.get("test-key");
          return "stored:" + JSON.stringify(result);
        },
      },
    },
  },
};
`;

const FS_ATTACK_BUNDLE = `
module.exports = {
  default: {
    name: "fs-attack",
    systemPrompt: "Test",
    greeting: "",
    maxSteps: 1,
    tools: {
      read_host_file: {
        description: "Try to read host file",
        async execute() {
          const fs = require("fs");
          try {
            const content = fs.readFileSync("/etc/hostname", "utf-8");
            return "read:" + content;
          } catch (err) {
            return "error:" + err.message;
          }
        },
      },
    },
  },
};
`;

const NET_ATTACK_BUNDLE = `
module.exports = {
  default: {
    name: "net-attack",
    systemPrompt: "Test",
    greeting: "",
    maxSteps: 1,
    tools: {
      http_request: {
        description: "Try to make an HTTP request",
        async execute() {
          const http = require("http");
          return new Promise((resolve) => {
            const req = http.get("http://169.254.169.254/latest/meta-data/", { timeout: 2000 }, (res) => {
              resolve("connected:" + res.statusCode);
            });
            req.on("error", (err) => resolve("error:" + err.message));
            req.on("timeout", () => { req.destroy(); resolve("error:timeout"); });
          });
        },
      },
    },
  },
};
`;

// ── Test suite ──────────────────────────────────────────────────────────────

const canRun = isFirecrackerAvailable() && guestArtifactsExist();

describe.skipIf(!canRun)("Firecracker integration", () => {
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-fc-integ-"));
  });

  afterAll(async () => {
    // Kill all VMs
    for (const vm of activeVms) {
      try {
        vm.process.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    activeVms.length = 0;

    // Clean up temp dir
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    // Clean up snapshot files
    for (const f of [SNAPSHOT_STATE_PATH, SNAPSHOT_MEM_PATH]) {
      try {
        await fs.unlink(f);
      } catch {
        // may not exist
      }
    }
  });

  // ── Test 1: VM boot and vsock connectivity ──────────────────────────────

  test("VM cold boots and responds to ping over vsock", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath } = await coldBootVm({ guestCid: cid, vsockUdsPath });

    // Start the VM
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    // Connect to guest over vsock
    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    try {
      // Send bundle first (harness expects bundle as first message)
      const bundleResp = await channel.request(
        {
          type: "bundle",
          code: SIMPLE_AGENT_BUNDLE,
          env: {},
        },
        { timeout: 10_000 },
      );
      expect(bundleResp.ok).toBe(true);

      // Now send a hook to verify connectivity
      const hookResp = await channel.request(
        { type: "hook", hook: "onConnect", sessionId: "test-session" },
        { timeout: 10_000 },
      );
      expect(hookResp).toBeDefined();
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 60_000);

  // ── Test 2: Snapshot create and restore ─────────────────────────────────

  test("creates snapshot and restores VM from it", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    // Cold boot
    const { apiSocketPath, process: fcProcess } = await coldBootVm({
      guestCid: cid,
      vsockUdsPath,
    });

    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    // Wait for guest to be ready (connect over vsock)
    const { socket: sock1, channel: chan1 } = await connectVsock(vsockUdsPath, cid, 30_000);

    // Send bundle to mark guest as ready
    const bundleResp = await chan1.request(
      { type: "bundle", code: SIMPLE_AGENT_BUNDLE, env: {} },
      { timeout: 10_000 },
    );
    expect(bundleResp.ok).toBe(true);

    // Close vsock before pausing
    chan1.close();
    sock1.destroy();

    // Pause the VM
    await firecrackerApi(apiSocketPath, "PATCH", "/vm", { state: "Paused" });

    // Take snapshot
    await firecrackerApi(apiSocketPath, "PUT", "/snapshot/create", {
      snapshot_type: "Full",
      snapshot_path: SNAPSHOT_STATE_PATH,
      mem_file_path: SNAPSHOT_MEM_PATH,
    });

    // Kill the cold-booted VM
    fcProcess.kill("SIGKILL");

    // Now restore from snapshot in a new Firecracker process
    const cid2 = nextCid();
    const vsockUdsPath2 = path.join(tmpDir, `vsock-${cid2}.sock`);
    const apiSocket2 = path.join(tmpDir, `fc-api-restore-${cid2}.sock`);

    const { spawn } = await import("node:child_process");
    const fc2 = spawn("firecracker", ["--api-sock", apiSocket2], {
      stdio: "ignore",
      detached: false,
    });

    activeVms.push({
      process: fc2,
      apiSocketPath: apiSocket2,
      vsockUdsPath: vsockUdsPath2,
      guestCid: cid2,
      kill: async () => {
        fc2.kill("SIGKILL");
      },
    });

    await waitForSocket(apiSocket2, 5000);

    // Restore from snapshot
    await firecrackerApi(apiSocket2, "PUT", "/snapshot/load", {
      snapshot_path: SNAPSHOT_STATE_PATH,
      mem_backend: { backend_path: SNAPSHOT_MEM_PATH, backend_type: "File" },
    });

    await firecrackerApi(apiSocket2, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    // Verify the restored VM is reachable over vsock
    const { socket: sock2, channel: chan2 } = await connectVsock(vsockUdsPath2, cid2, 30_000);

    try {
      // The restored VM should still have the agent loaded
      const hookResp = await chan2.request(
        { type: "hook", hook: "onConnect", sessionId: "restored-session" },
        { timeout: 10_000 },
      );
      expect(hookResp).toBeDefined();
    } finally {
      chan2.close();
      sock2.destroy();
      fc2.kill("SIGKILL");
    }
  }, 120_000);

  // ── Test 3: Bundle injection and tool execution ─────────────────────────

  test("injects bundle and executes tool via RPC", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath } = await coldBootVm({ guestCid: cid, vsockUdsPath });
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    try {
      // Inject bundle
      const bundleResp = await channel.request(
        { type: "bundle", code: SIMPLE_AGENT_BUNDLE, env: {} },
        { timeout: 10_000 },
      );
      expect(bundleResp.ok).toBe(true);

      // Connect a session
      await channel.request(
        { type: "hook", hook: "onConnect", sessionId: "tool-session" },
        { timeout: 10_000 },
      );

      // Execute tool
      const toolResp = await channel.request(
        {
          type: "tool",
          name: "echo",
          sessionId: "tool-session",
          args: { text: "hello-firecracker" },
          messages: [],
        },
        { timeout: 10_000 },
      );

      expect(toolResp.result).toBe("echo:hello-firecracker");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 60_000);

  // ── Test 4: KV round-trip ──────────────────────────────────────────────

  test("KV get/set round-trips through host proxy", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath } = await coldBootVm({ guestCid: cid, vsockUdsPath });
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    // Set up a KV handler on the host side to respond to guest KV requests
    const kvStore = new Map<string, unknown>();
    channel.onRequest("kv", async (msg) => {
      const op = msg.op as string;
      if (op === "get") {
        return { value: kvStore.get(msg.key as string) ?? null };
      }
      if (op === "set") {
        kvStore.set(msg.key as string, msg.value);
        return { ok: true };
      }
      return { error: `Unknown op: ${op}` };
    });

    try {
      // Inject KV agent bundle
      const bundleResp = await channel.request(
        { type: "bundle", code: KV_AGENT_BUNDLE, env: {} },
        { timeout: 10_000 },
      );
      expect(bundleResp.ok).toBe(true);

      // Connect session
      await channel.request(
        { type: "hook", hook: "onConnect", sessionId: "kv-session" },
        { timeout: 10_000 },
      );

      // Execute kv_roundtrip tool
      const toolResp = await channel.request(
        {
          type: "tool",
          name: "kv_roundtrip",
          sessionId: "kv-session",
          args: { value: "firecracker-value" },
          messages: [],
        },
        { timeout: 10_000 },
      );

      expect(toolResp.result).toBe('stored:"firecracker-value"');
      expect(kvStore.get("test-key")).toBe("firecracker-value");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 60_000);

  // ── Test 5: Cross-agent memory isolation ───────────────────────────────

  test("two VMs have isolated memory (no shared globalThis)", async () => {
    const BUNDLE_A = `
module.exports = {
  default: {
    name: "agent-a",
    systemPrompt: "A",
    greeting: "",
    maxSteps: 1,
    tools: {
      set_secret: {
        description: "Set globalThis.secret",
        execute() { globalThis.secret = "agent1-secret"; return "set"; },
      },
      get_secret: {
        description: "Read globalThis.secret",
        execute() { return "secret:" + (globalThis.secret || "undefined"); },
      },
    },
  },
};
`;

    const BUNDLE_B = `
module.exports = {
  default: {
    name: "agent-b",
    systemPrompt: "B",
    greeting: "",
    maxSteps: 1,
    tools: {
      get_secret: {
        description: "Read globalThis.secret",
        execute() { return "secret:" + (globalThis.secret || "undefined"); },
      },
    },
  },
};
`;

    // Boot two VMs
    const cid1 = nextCid();
    const cid2 = nextCid();
    const vsock1 = path.join(tmpDir, `vsock-${cid1}.sock`);
    const vsock2 = path.join(tmpDir, `vsock-${cid2}.sock`);

    const { apiSocketPath: api1 } = await coldBootVm({ guestCid: cid1, vsockUdsPath: vsock1 });
    const { apiSocketPath: api2 } = await coldBootVm({ guestCid: cid2, vsockUdsPath: vsock2 });

    await firecrackerApi(api1, "PUT", "/actions", { action_type: "InstanceStart" });
    await firecrackerApi(api2, "PUT", "/actions", { action_type: "InstanceStart" });

    const { socket: sock1, channel: chan1 } = await connectVsock(vsock1, cid1, 30_000);
    const { socket: sock2, channel: chan2 } = await connectVsock(vsock2, cid2, 30_000);

    try {
      // Inject bundles
      await chan1.request({ type: "bundle", code: BUNDLE_A, env: {} }, { timeout: 10_000 });
      await chan2.request({ type: "bundle", code: BUNDLE_B, env: {} }, { timeout: 10_000 });

      // Connect sessions
      await chan1.request(
        { type: "hook", hook: "onConnect", sessionId: "s1" },
        { timeout: 10_000 },
      );
      await chan2.request(
        { type: "hook", hook: "onConnect", sessionId: "s2" },
        { timeout: 10_000 },
      );

      // Agent 1 sets secret
      const setResp = await chan1.request(
        {
          type: "tool",
          name: "set_secret",
          sessionId: "s1",
          args: {},
          messages: [],
        },
        { timeout: 10_000 },
      );
      expect(setResp.result).toBe("set");

      // Agent 2 reads secret — should NOT see agent 1's value
      const getResp = await chan2.request(
        {
          type: "tool",
          name: "get_secret",
          sessionId: "s2",
          args: {},
          messages: [],
        },
        { timeout: 10_000 },
      );
      expect(getResp.result).toBe("secret:undefined");
    } finally {
      chan1.close();
      chan2.close();
      sock1.destroy();
      sock2.destroy();
    }
  }, 120_000);

  // ── Test 6: Agent cannot access host filesystem ────────────────────────

  test("agent cannot read host filesystem (/etc/hostname)", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath } = await coldBootVm({ guestCid: cid, vsockUdsPath });
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    try {
      await channel.request(
        { type: "bundle", code: FS_ATTACK_BUNDLE, env: {} },
        { timeout: 10_000 },
      );

      await channel.request(
        { type: "hook", hook: "onConnect", sessionId: "fs-session" },
        { timeout: 10_000 },
      );

      const toolResp = await channel.request(
        {
          type: "tool",
          name: "read_host_file",
          sessionId: "fs-session",
          args: {},
          messages: [],
        },
        { timeout: 10_000 },
      );

      // The tool should fail — /etc/hostname does not exist in the initrd
      expect(toolResp.result).toMatch(/^error:/);
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 60_000);

  // ── Test 7: Agent cannot access network ────────────────────────────────

  test("agent cannot make HTTP requests (no network device)", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath } = await coldBootVm({ guestCid: cid, vsockUdsPath });
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    try {
      await channel.request(
        { type: "bundle", code: NET_ATTACK_BUNDLE, env: {} },
        { timeout: 10_000 },
      );

      await channel.request(
        { type: "hook", hook: "onConnect", sessionId: "net-session" },
        { timeout: 10_000 },
      );

      const toolResp = await channel.request(
        {
          type: "tool",
          name: "http_request",
          sessionId: "net-session",
          args: {},
          messages: [],
        },
        { timeout: 15_000 },
      );

      // The tool should fail — no network interface in the VM
      expect(toolResp.result).toMatch(/^error:/);
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 60_000);

  // ── Test 8: Shutdown ──────────────────────────────────────────────────

  test("shutdown message causes VM guest to exit", async () => {
    const cid = nextCid();
    const vsockUdsPath = path.join(tmpDir, `vsock-${cid}.sock`);

    const { apiSocketPath, process: fcProcess } = await coldBootVm({
      guestCid: cid,
      vsockUdsPath,
    });
    await firecrackerApi(apiSocketPath, "PUT", "/actions", {
      action_type: "InstanceStart",
    });

    const { socket, channel } = await connectVsock(vsockUdsPath, cid, 30_000);

    // Inject bundle
    await channel.request(
      { type: "bundle", code: SIMPLE_AGENT_BUNDLE, env: {} },
      { timeout: 10_000 },
    );

    // Send shutdown
    const shutdownResp = await channel.request({ type: "shutdown" }, { timeout: 10_000 });
    expect(shutdownResp.ok).toBe(true);

    // Wait briefly for the guest process to exit — the vsock connection
    // should close after the guest calls process.exit(0)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("end", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // The guest has exited; clean up the Firecracker process
    fcProcess.kill("SIGKILL");

    // Verify the socket is no longer connected
    expect(socket.destroyed || socket.closed).toBe(true);
  }, 60_000);
});
