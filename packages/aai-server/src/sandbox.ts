// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * The isolate runs the same `createRuntime()` + WebSocket server as
 * self-hosted mode. The host boots the isolate, then proxies client
 * WebSocket connections to it.
 */

import {
  type AgentRuntime,
  buildReadyConfig,
  createUnstorageKv,
  DEFAULT_S2S_CONFIG,
  errorMessage,
  isReadOnlyFsOp,
  type SessionStartOptions,
  type SessionWebSocket,
} from "@alexkroman1/aai/internal";
import pTimeout from "p-timeout";
import {
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
} from "secure-exec";
import type { Storage } from "unstorage";
import { z } from "zod";
import type { BundleStore } from "./bundle-store.ts";
import { PORT_ANNOUNCE_TIMEOUT_MS, SANDBOX_MEMORY_LIMIT_MB } from "./constants.ts";
import { getHarnessRuntimeJs } from "./sandbox-harness.ts";
import { buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";
import {
  resolveSandbox as _resolveSandboxCore,
  _slotInternals,
  type AgentSlot,
} from "./sandbox-slots.ts";

export type { AgentMetadata } from "./_schemas.ts";
export { type AgentSlot, ensureAgent, registerSlot } from "./sandbox-slots.ts";

export type SandboxOptions = {
  workerCode: string;
  /** Platform API key (e.g. AssemblyAI) — used by the host only, never sent to the isolate. */
  apiKey: string;
  /** Agent-defined secrets — forwarded to the isolate via AAI_ENV_ prefixed process env. */
  agentEnv: Record<string, string>;
  storage: Storage;
  slug: string;
};

export type Sandbox = AgentRuntime & {
  /** @deprecated Use {@link AgentRuntime.shutdown} instead. Kept for existing callers. */
  terminate(): Promise<void>;
};

// ── Port announcement schema ────────────────────────────────────────────

const PortAnnounceSchema = z.object({
  port: z.number(),
  name: z.string().optional(),
});

// ── Isolate lifecycle ────────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  kv: import("@alexkroman1/aai/kv").Kv,
  agentEnv: Record<string, string>,
): Promise<{ port: number; name: string; runtime: NodeRuntime; crashed: AbortSignal }> {
  const harnessJs = await getHarnessRuntimeJs();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  await fs.writeFile("/app/_harness-runtime.js", harnessJs);

  // Prefix agent env vars with AAI_ENV_ so the harness can identify them.
  const prefixedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  const crashController = new AbortController();

  let resolveAnnounce: (v: { port: number; name: string }) => void;
  let rejectAnnounce: (err: Error) => void;
  let announced = false;
  const announcePromise = new Promise<{ port: number; name: string }>((resolve, reject) => {
    resolveAnnounce = resolve;
    rejectAnnounce = reject;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          isReadOnlyFsOp(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: buildNetworkPolicy(),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: (req) =>
          req.op === "read" && allowedKeys.has(req.key ?? "")
            ? { allow: true }
            : { allow: false, reason: "Env access restricted" },
      },
      networkAdapter: buildNetworkAdapter(kv),
      processConfig: {
        env: prefixedEnv,
        timingMitigation: "freeze",
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: SANDBOX_MEMORY_LIMIT_MB,
    onStdio(event) {
      if (event.channel === "stdout") {
        try {
          const parsed = PortAnnounceSchema.safeParse(JSON.parse(event.message));
          if (parsed.success && !announced) {
            announced = true;
            resolveAnnounce({ port: parsed.data.port, name: parsed.data.name ?? "agent" });
          }
        } catch {
          // Not the port announcement, ignore
        }
      }
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  const execPromise = runtime
    .exec(
      'import agent from "/app/agent_bundle.js";\nimport { startHarness } from "/app/_harness-runtime.js";\nstartHarness(agent);',
      { cwd: "/app" },
    )
    .catch((err: unknown) => {
      rejectAnnounce(new Error(`Isolate exited before announcing port: ${err}`));
    });

  const { port, name } = await pTimeout(announcePromise, {
    milliseconds: PORT_ANNOUNCE_TIMEOUT_MS,
    message: `Isolate failed to announce port within ${PORT_ANNOUNCE_TIMEOUT_MS}ms`,
  });

  execPromise.catch((err) => {
    if (!crashController.signal.aborted) {
      crashController.abort(new Error(`Isolate crashed: ${errorMessage(err)}`));
    }
  });

  return { port, name, runtime, crashed: crashController.signal };
}

// ── WebSocket proxy ─────────────────────────────────────────────────────

/**
 * Proxy a client WebSocket to the isolate's WebSocket server.
 * Messages are forwarded bidirectionally with zero parsing.
 */
function proxyWebSocket(
  clientWs: SessionWebSocket,
  isolatePort: number,
  opts?: SessionStartOptions,
): void {
  const url = new URL(`ws://127.0.0.1:${isolatePort}/websocket`);
  if (opts?.resumeFrom) url.searchParams.set("sessionId", opts.resumeFrom);
  if (opts?.skipGreeting) url.searchParams.set("resume", "1");

  const isolateWs = new WebSocket(url.toString());

  // Buffer client messages until isolate WS is open
  let isolateOpen = false;
  let buffer: (string | ArrayBuffer | Uint8Array)[] | null = [];

  function flushBuffer() {
    if (!buffer) return;
    const buf = buffer;
    buffer = null;
    isolateOpen = true;
    for (const msg of buf) {
      isolateWs.send(msg);
    }
  }

  function sendToIsolate(data: string | ArrayBuffer | Uint8Array) {
    if (!isolateOpen) {
      buffer?.push(data);
      return;
    }
    if (isolateWs.readyState === WebSocket.OPEN) {
      isolateWs.send(data);
    }
  }

  // Client → Isolate
  clientWs.addEventListener("message", (event) => {
    const { data } = event;
    if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
      sendToIsolate(data);
    }
  });

  // Isolate → Client
  isolateWs.addEventListener("open", () => {
    opts?.onOpen?.();
    flushBuffer();
  });

  isolateWs.addEventListener("message", (event) => {
    if (clientWs.readyState !== 1) return;
    const { data } = event;
    if (typeof data === "string") {
      clientWs.send(data);
    } else if (data instanceof ArrayBuffer) {
      clientWs.send(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      clientWs.send(data);
    }
  });

  // Cleanup
  clientWs.addEventListener("close", () => {
    opts?.onClose?.();
    if (isolateWs.readyState === WebSocket.OPEN || isolateWs.readyState === WebSocket.CONNECTING) {
      isolateWs.close();
    }
  });

  isolateWs.addEventListener("close", () => {
    // Isolate WS closed — nothing to do, client manages its own lifecycle
  });

  isolateWs.addEventListener("error", () => {
    // Connection to isolate failed — client will time out naturally
  });
}

/** @internal Exposed for testing only. */
export const _internals = {
  startIsolate,
  createSandbox,
  get IDLE_MS() {
    return _slotInternals.IDLE_MS;
  },
  set IDLE_MS(ms: number) {
    _slotInternals.IDLE_MS = ms;
  },
  resetIdleTimer: _slotInternals.resetIdleTimer,
};

// ── Public API ───────────────────────────────────────────────────────────

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, agentEnv, storage, slug } = opts;

  const kv = createUnstorageKv({ storage, prefix: `agents/${slug}/kv` });
  const {
    port: isolatePort,
    name: agentName,
    runtime,
  } = await startIsolate(workerCode, kv, agentEnv);

  const readyConfig = buildReadyConfig(DEFAULT_S2S_CONFIG);

  console.info("Sandbox initialized", { slug, isolatePort, agent: agentName });

  async function shutdownSandbox(): Promise<void> {
    await runtime.terminate().catch((err: unknown) => {
      const msg = errorMessage(err);
      if (!msg.includes("already disposed")) {
        console.warn("Runtime terminate failed:", err);
      }
    });
  }

  return {
    readyConfig,
    startSession(socket: SessionWebSocket, startOpts?: SessionStartOptions): void {
      proxyWebSocket(socket, isolatePort, startOpts);
    },
    shutdown: shutdownSandbox,
    terminate: shutdownSandbox,
  };
}

/** Wrapper that injects `createSandbox` so sandbox-slots needs no back-reference. */
export async function resolveSandbox(
  slug: string,
  opts: {
    slots: Map<string, AgentSlot>;
    store: BundleStore;
    storage: Storage;
  },
): Promise<Sandbox | null> {
  return _resolveSandboxCore(slug, { ...opts, createSandbox });
}
