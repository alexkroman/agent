// Copyright 2026 the AAI authors. MIT license.
/**
 * Modal-backed sandbox spawning.
 *
 * Every guest harness runs in a [Modal Sandbox](https://modal.com/docs/guide/sandbox)
 * — a remote, isolated container managed by Modal's infrastructure. The host
 * creates a sandbox from a Deno image, writes the built guest harness into
 * its filesystem, and execs `deno run --no-prompt /harness.mjs`. The exec'd
 * process's stdin/stdout carry the same NDJSON JSON-RPC protocol the guest
 * harness has always spoken; only the transport underneath changed (Modal's
 * command router instead of local child-process pipes).
 *
 * Security properties preserved from the previous gVisor backend:
 * - **No guest network**: sandboxes are created with `blockNetwork: true`.
 *   All external calls still proxy through host-side RPC (`fetch/request`).
 * - **No secrets in the guest environment**: agent env is delivered via the
 *   `bundle/load` RPC params, never as sandbox environment variables.
 * - **No host filesystem**: the sandbox sees only the Deno image plus the
 *   harness file written into it.
 * - **Resource limits**: memory/CPU caps map onto Modal's per-sandbox
 *   `memoryLimitMiB`/`cpuLimit` options.
 *
 * Credentials: `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` (or a `~/.modal.toml`
 * profile — the SDK resolves both). There is no fallback backend: without
 * Modal credentials, sandbox creation fails loudly in dev and prod alike.
 */

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import { ModalClient, type SandboxCreateParams } from "modal";
import { debug } from "./_debug-log.ts";
import { HARNESS_HEARTBEAT_INTERVAL_MS } from "./guest/limits.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  parseSandboxLimitsFromEnv,
  parseSandboxRegionsFromEnv,
} from "./modal-sandbox-env.ts";
import { createNdjsonConnection } from "./ndjson-transport.ts";
import type { GuestRpcSchema } from "./rpc-schemas.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

// ── Structural Modal types ───────────────────────────────────────────────────
// Minimal shapes of the Modal SDK objects we touch. Structural rather than the
// SDK classes so unit tests can inject fakes without constructing gRPC
// clients; the real `Sandbox`/`ContainerProcess` satisfy them.

export type ModalProcLike = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code once the process finishes. */
  wait(): Promise<number>;
};

export type ModalSandboxLike = {
  sandboxId: string;
  filesystem: {
    writeText(data: string, remotePath: string): Promise<unknown>;
  };
  exec(
    command: string[],
    params: { mode: "binary"; stdout: "pipe"; stderr: "pipe" },
  ): Promise<ModalProcLike>;
  terminate(): Promise<unknown>;
};

/** The one operation spawning needs from Modal — injectable for tests. */
export type ModalSpawnContext = {
  createSandbox(params: SandboxCreateParams): Promise<ModalSandboxLike>;
};

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Default image for guest sandboxes. Only Deno is required — the harness is
 * written into the sandbox at spawn time. Override with `MODAL_SANDBOX_IMAGE`
 * (pin a version tag in production for reproducible guests).
 */
const DEFAULT_SANDBOX_IMAGE = "denoland/deno:latest";

/** Modal App the sandboxes are created under. Override with `MODAL_APP_NAME`. */
const DEFAULT_MODAL_APP_NAME = "aai-server";

/** Where the guest harness is written inside the sandbox. */
const HARNESS_REMOTE_PATH = "/tmp/harness.mjs";

export function modalRequiredError(): Error {
  return new Error(
    "Modal credentials are required to run agent sandboxes. " +
      "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (or configure ~/.modal.toml) — " +
      "see https://modal.com/docs/reference/modal.config. " +
      "Running untrusted agent code without sandbox isolation is not allowed.",
  );
}

// One ModalClient per process — construction only resolves credentials
// (env vars / ~/.modal.toml), so `isModalConfigured` and `buildContext`
// share the instance.
let clientMemo: ModalClient | null = null;

function modalClient(): ModalClient {
  clientMemo ??= new ModalClient();
  return clientMemo;
}

/** True when the Modal SDK can resolve credentials (env vars or ~/.modal.toml). */
export function isModalConfigured(): boolean {
  try {
    const client = modalClient();
    return Boolean(client.profile.tokenId && client.profile.tokenSecret);
  } catch {
    return false;
  }
}

// ── Modal context (client/app/image, resolved once) ──────────────────────────

let contextPromise: Promise<ModalSpawnContext> | null = null;

async function buildContext(): Promise<ModalSpawnContext> {
  if (!isModalConfigured()) throw modalRequiredError();
  const client = modalClient();
  const appName = process.env.MODAL_APP_NAME ?? DEFAULT_MODAL_APP_NAME;
  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const image = client.images.fromRegistry(
    process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
  );
  return {
    createSandbox: (params) => client.sandboxes.create(app, image, params),
  };
}

/**
 * Resolve the shared Modal context. Memoized; a failure clears the memo so
 * the next spawn retries (a transient control-plane error must not disable
 * sandboxing for the process lifetime).
 */
function modalContext(): Promise<ModalSpawnContext> {
  contextPromise ??= buildContext().catch((err: unknown) => {
    contextPromise = null;
    throw err;
  });
  return contextPromise;
}

/**
 * Fire-and-forget warm-up of the memoized Modal context (app lookup/creation
 * is a gRPC round trip that would otherwise land on the first session's cold
 * start). A failure only warns — the next spawn retries via the memo reset.
 */
export function prewarmModal(): void {
  void modalContext().catch((err: unknown) => {
    console.warn(`Modal context prewarm failed: ${errorMessage(err)}`);
  });
}

// ── Harness code cache ───────────────────────────────────────────────────────

const harnessCache = new Map<string, Promise<string>>();

/** Read (and memoize) the built guest harness — it is stable per process. */
function harnessCode(harnessPath: string): Promise<string> {
  let cached = harnessCache.get(harnessPath);
  if (!cached) {
    cached = readFile(harnessPath, "utf-8").catch((err: unknown) => {
      harnessCache.delete(harnessPath);
      throw err;
    });
    harnessCache.set(harnessPath, cached);
  }
  return cached;
}

// ── Web stream ⇄ Node stream adapters ────────────────────────────────────────
// The NDJSON transport speaks Node streams (readline + write/drain); Modal's
// ContainerProcess exposes WHATWG streams. Hand-rolled pumps rather than
// Readable.fromWeb/Writable.fromWeb because the SDK's stream types are the
// DOM's, not node:stream/web's, and the manual form also gives us explicit
// dead-peer behavior: a reader failure ends the readable (readline close →
// pending RPCs rejected), and writer failures surface as stream errors the
// transport already guards against.

function webToNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
  const reader = stream.getReader();
  return new Readable({
    read() {
      reader.read().then(
        ({ done, value }) => {
          if (done) this.push(null);
          else this.push(Buffer.from(value));
        },
        () => {
          // Peer died mid-read; end of stream is how the RPC layer learns.
          this.push(null);
        },
      );
    },
  });
}

function webToNodeWritable(stream: WritableStream<Uint8Array>): Writable {
  const writer = stream.getWriter();
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      // Buffer is a Uint8Array, so it crosses the web-stream boundary as-is.
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(
        () => cb(),
        () => cb(),
      );
    },
    destroy(err, cb) {
      void writer.abort(err ?? undefined).catch(() => undefined);
      cb(err);
    },
  });
}

// ── stderr logging ───────────────────────────────────────────────────────────

/**
 * Cap on stderr bytes logged per sandbox. Guest stack traces are diagnostic
 * gold, but a guest looping on writes must not flood the host's logs — past
 * the cap the stream keeps draining silently (never stop consuming, or the
 * guest wedges on its next stderr write).
 */
const MAX_STDERR_LOG_BYTES = 64 * 1024;

async function drainStderr(stream: ReadableStream<Uint8Array>, sandboxId: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let logged = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (logged >= MAX_STDERR_LOG_BYTES) continue; // keep draining, stop logging
      logged += value.byteLength;
      const text = decoder.decode(value, { stream: true }).trimEnd();
      if (text) console.warn(`[modal:${sandboxId}] stderr: ${text}`);
    }
  } catch {
    // Peer died mid-read; process exit handling covers teardown.
  }
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/** Wrap a Modal sandbox + exec'd harness process into the WarmHarness shape. */
function warmFromModal(sb: ModalSandboxLike, proc: ModalProcLike): WarmHarness {
  const stdout = webToNodeReadable(proc.stdout);
  const stdin = webToNodeWritable(proc.stdin);
  // A guest that dies mid-RPC leaves its streams to error asynchronously.
  // Without listeners those become an uncaughtException that exits the whole
  // multi-tenant host.
  stdout.on("error", () => {
    /* guest died; RPC layer surfaces this via the readline close */
  });
  stdin.on("error", () => {
    /* guest died; RPC layer surfaces this via the readline close */
  });
  void drainStderr(proc.stderr, sb.sandboxId);

  const conn = createNdjsonConnection<GuestRpcSchema>(stdout, stdin);

  // Host-liveness heartbeat: the guest's orphan watchdog exits the harness
  // after HARNESS_ORPHAN_TIMEOUT_MS without stdin traffic, so every live
  // harness — pooled and unconfigured included — must hear from us on a
  // shorter cadence. Unref'd (must never hold the host process open) and
  // cleared the moment the harness is known dead or torn down; the guest
  // needs no `ping` handler, any inbound line feeds its watchdog.
  const heartbeat = setInterval(() => {
    void conn.sendNotification("ping");
  }, HARNESS_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const exitListeners: (() => void)[] = [];
  let dead = false;
  const notifyExit = (): void => {
    if (dead) return;
    dead = true;
    clearInterval(heartbeat);
    for (const cb of exitListeners) {
      try {
        cb();
      } catch {
        // Listener errors must not crash the host
      }
    }
  };
  // The harness process ending — clean exit, sandbox timeout, OOM kill,
  // terminate() — all settle wait(); either way the harness is gone.
  proc.wait().then(notifyExit, notifyExit);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    // Memoized: a concurrent second caller must wait for the sandbox to
    // actually be terminated, not return before the first caller finished.
    cleanupPromise ??= (async () => {
      notifyExit();
      try {
        await sb.terminate();
      } catch {
        // Best-effort — the sandbox may already be gone (timeout, crash).
      }
    })();
    return cleanupPromise;
  };

  return {
    conn,
    cleanup,
    alive: () => !dead,
    onExit: (cb) => {
      exitListeners.push(cb);
    },
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Deno harness in a fresh Modal sandbox. The returned
 * WarmHarness has a running harness process and a connected NDJSON channel,
 * but no listeners attached and no bundle loaded.
 *
 * `slug` is attached as a sandbox tag for observability only; the security
 * boundary is Modal's sandbox isolation + blockNetwork.
 */
export async function spawnModalWarm(
  opts: { harnessPath: string; slug?: string },
  ctx?: ModalSpawnContext,
): Promise<WarmHarness> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const limits = parseSandboxLimitsFromEnv(process.env);
  const regions = parseSandboxRegionsFromEnv(process.env);

  const t0 = performance.now();
  const sb = await context.createSandbox({
    // Explicit idle entrypoint. Without a command Modal falls back to the
    // image's default process, and denoland/deno's docker-entrypoint.sh
    // treats its arguments as Deno subcommands — the container exits
    // immediately and every later filesystem/exec call reports "Sandbox may
    // have already shut down". `sleep infinity` matches Modal's documented
    // default main-process behavior ("sleep indefinitely"), which idle
    // detection ignores — the exec'd harness is what holds the sandbox
    // active, so its exit is what starts the idle timer.
    command: ["sleep", "infinity"],
    // The denoland/deno image's entrypoint wraps the command in tini, which
    // Modal does not run as PID 1 — without this, every sandbox logs a tini
    // warning that it cannot reap re-parented zombies. Registering tini as a
    // child subreaper silences the warning and makes the reaping real. Not an
    // agent secret: agent env is delivered via bundle/load RPC, never here.
    env: { TINI_SUBREAPER: "1" },
    // The guest has no network by design — all egress is host-proxied RPC.
    blockNetwork: true,
    timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    ...(limits.memoryLimitMiB !== undefined && { memoryLimitMiB: limits.memoryLimitMiB }),
    ...(limits.cpuLimit !== undefined && { cpuLimit: limits.cpuLimit }),
    // Co-locate guests with the host — see parseSandboxRegionsFromEnv.
    ...(regions && { regions }),
    tags: { service: "aai-guest", slug: opts.slug ?? "pool" },
  });
  try {
    await sb.filesystem.writeText(code, HARNESS_REMOTE_PATH);

    // Permissions: `--no-prompt` and nothing else — the bundle arrives over
    // RPC and loads from a `blob:` URL, so the harness needs no Deno grants.
    const proc = await sb.exec(["deno", "run", "--no-prompt", HARNESS_REMOTE_PATH], {
      mode: "binary",
      stdout: "pipe",
      stderr: "pipe",
    });
    const tExec = performance.now();

    debug("Modal sandbox spawned", {
      sandboxId: sb.sandboxId,
      slug: opts.slug ?? "pool",
      ms: Math.round(tExec - t0),
    });

    return warmFromModal(sb, proc);
  } catch (err) {
    // Never leak a sandbox whose harness failed to start.
    await sb.terminate().catch(() => undefined);
    throw new Error(`Modal sandbox spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  warmFromModal,
  webToNodeReadable,
  webToNodeWritable,
  drainStderr,
  resetModalContext(): void {
    contextPromise = null;
    clientMemo = null;
    harnessCache.clear();
  },
};
