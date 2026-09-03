// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared test helpers for the sandbox test files: a fake guest WebSocket (the
 * seam `rpc-transport.ts` speaks to), fakes for Modal's sandbox/process/spawn
 * surfaces, and the agent-spawn options base.
 *
 * The Modal fakes are shared by the two spawn suites — `modal-sandbox.test.ts`
 * (studio/inspect guests, which get a control channel) and
 * `modal-agent-sandbox.test.ts` (deployed agents, which get none) — because
 * the two paths differ only in what they do WITH the sandbox, and a second
 * copy of the fakes would let them drift apart.
 */

import { hash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ModalProcLike, ModalSandboxLike, ModalSpawnContext } from "./modal-context.ts";
import { GUEST_PORT } from "./modal-context.ts";
import type { RpcWebSocket } from "./rpc-transport.ts";
import type { AgentSpawnOptions, WorkerSource } from "./sandbox-vm.ts";

/** A fake guest endpoint: what the host sent, plus a way to answer. */
export type FakeGuestSocket = {
  ws: RpcWebSocket;
  /** Raw JSON frames the host sent to the guest, in order. */
  writtenLines: string[];
  /** Parsed frames the host sent to the guest. */
  sentMessages(): Record<string, unknown>[];
  /** Deliver one message from the guest to the host. */
  receive(msg: unknown): void;
  /** Observe every frame the host sends (for auto-responders). */
  onSend(cb: (msg: Record<string, unknown>) => void): void;
  /** Close the socket from the guest side. */
  close(): void;
};

export function createFakeGuestSocket(): FakeGuestSocket {
  const messageHandlers: ((data: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  const sendObservers: ((msg: Record<string, unknown>) => void)[] = [];
  const writtenLines: string[] = [];
  let state = 1; // OPEN

  const ws: RpcWebSocket = {
    get readyState() {
      return state;
    },
    OPEN: 1,
    send(data: string) {
      writtenLines.push(data);
      const parsed = JSON.parse(data) as Record<string, unknown>;
      for (const cb of sendObservers) cb(parsed);
    },
    close() {
      if (state !== 1) return;
      state = 3;
      for (const cb of closeHandlers) cb();
    },
    on(event: "message" | "close", cb: ((data: unknown) => void) | (() => void)) {
      if (event === "message") messageHandlers.push(cb as (data: unknown) => void);
      else closeHandlers.push(cb as () => void);
    },
  };

  return {
    ws,
    writtenLines,
    sentMessages: () => writtenLines.map((l) => JSON.parse(l) as Record<string, unknown>),
    receive(msg: unknown) {
      const data = typeof msg === "string" ? msg : JSON.stringify(msg);
      for (const cb of messageHandlers) cb(data);
    },
    onSend(cb) {
      sendObservers.push(cb);
    },
    close: () => ws.close(),
  };
}

/** An `inline` {@link WorkerSource} with a matching hash, as a spawner sees it. */
export function inlineWorker(code = 'export default { name: "test" };'): WorkerSource {
  return { kind: "inline", code, sha256: hash("sha256", code) };
}

export function baseOpts(overrides?: Partial<AgentSpawnOptions>): AgentSpawnOptions {
  return {
    slug: "test-agent",
    version: 1,
    worker: inlineWorker(),
    env: { FOO: "bar" },
    harnessPath: "/tmp/harness.mjs",
    ...overrides,
  };
}

// ── Modal fakes ──────────────────────────────────────────────────────────────

export type FakeProc = {
  proc: ModalProcLike;
  /** Push bytes onto the guest's stderr. */
  pushStderr(text: string): void;
  /** Settle proc.wait(). */
  exit(code: number): void;
};

export function makeFakeProc(): FakeProc {
  const encoder = new TextEncoder();
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrController = c;
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  const { promise: waitPromise, resolve: resolveWait } = Promise.withResolvers<number>();
  return {
    proc: { stdout, stderr, wait: () => waitPromise },
    pushStderr: (text) => stderrController.enqueue(encoder.encode(text)),
    exit: (code) => resolveWait(code),
  };
}

/** Exactly what `ModalSandboxLike.exec` is handed — recorded verbatim. */
type ExecCall = {
  command: string[];
  params: Parameters<ModalSandboxLike["exec"]>[1];
};

export function makeFakeSandbox(fakeProc: FakeProc): ModalSandboxLike & {
  execCalls: ExecCall[];
  /** path → content written pre-exec (agent-mode boot artifacts). */
  files: Map<string, string>;
  updateNetworkPolicy: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  const execCalls: ExecCall[] = [];
  const files = new Map<string, string>();
  return {
    sandboxId: "sb-test",
    execCalls,
    files,
    // Modal's readiness probe, satisfied immediately: these tests exercise the
    // spawn sequence, not the boot wait (which raceGuestExit covers).
    waitUntilReady: () => Promise.resolve(),
    filesystem: {
      writeText: async (data: string, remotePath: string) => {
        files.set(remotePath, data);
      },
    },
    exec: async (command, params) => {
      execCalls.push({ command, params });
      return fakeProc.proc;
    },
    tunnels: async () => ({
      [GUEST_PORT]: { host: "tunnel.modal.test", port: 12_345 },
    }),
    updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

export async function makeHarnessFile(content = "// harness"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aai-modal-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

export function makeCtx(sb: ModalSandboxLike): ModalSpawnContext & { codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    lookupGuestSandbox: () => Promise.resolve(null),
    prepareGuestImage: () => Promise.resolve(),
    createGuestSandbox: async (code, _params) => {
      codes.push(code);
      return sb;
    },
  };
}
