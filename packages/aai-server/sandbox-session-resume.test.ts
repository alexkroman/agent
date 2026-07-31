// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica session resume (see session-state-store.ts + sandbox.ts).
 *
 * Integration-style: two `createSandbox` instances stand in for two server
 * replicas, each with its own stateful fake guest (a real per-guest state
 * map behind `session/export` / `session/restore` / `session/end`), sharing
 * one memory SessionStateStore the way replicas share the Postgres store.
 * A disconnect on "replica A" must persist the session's resumable state,
 * and a `resumeFrom` session on "replica B" must hydrate from it.
 */

import {
  createMemoryVector,
  restoreSessionNotes,
  snapshotSessionNotes,
} from "@alexkroman1/aai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createMemorySessionStateStore } from "./session-state-store.ts";

/** A fake guest harness with real session-state semantics. */
type FakeGuest = {
  conn: NdjsonConnection;
  /** The guest's per-session ctx.state map. */
  state: Map<string, Record<string, unknown>>;
};

function makeFakeGuest(): FakeGuest {
  const state = new Map<string, Record<string, unknown>>();
  const conn = {
    sendRequest: vi.fn((method: string, params: unknown) => {
      if (method === "session/export") {
        const { sessionId } = params as { sessionId: string };
        const exported = state.get(sessionId);
        return Promise.resolve(exported === undefined ? {} : { state: exported });
      }
      return Promise.resolve(undefined);
    }),
    sendNotification: vi.fn((method: string, params?: unknown) => {
      if (method === "session/restore") {
        const p = params as { sessionId: string; state: Record<string, unknown> };
        // Set-if-absent, mirroring the real harness.
        if (!state.has(p.sessionId)) state.set(p.sessionId, structuredClone(p.state));
      }
      if (method === "session/end") {
        state.delete((params as { sessionId: string }).sessionId);
      }
    }),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  } as unknown as NdjsonConnection;
  return { conn, state };
}

// One fresh fake guest per createSandboxVm call — index N is "replica N"'s guest.
const { guests, mockCreateSandboxVm } = vi.hoisted(() => {
  const guests: Array<{ conn: unknown; state: Map<string, Record<string, unknown>> }> = [];
  const mockCreateSandboxVm = vi.fn();
  return { guests, mockCreateSandboxVm };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  createSandboxVm: mockCreateSandboxVm,
}));

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      return orig.createRuntime({
        ...opts,
        // Sessions in these tests never complete a provider handshake — an
        // inert socket keeps S2S connects off the real network.
        createWebSocket: () => ({
          readyState: 0,
          send: () => undefined,
          close: () => undefined,
          addEventListener: () => undefined,
        }),
      });
    },
  };
});

const TEST_AGENT_CONFIG: IsolateConfig = {
  name: "test-agent",
  systemPrompt: "You are a test agent",
  greeting: "Hello!",
  maxSteps: 3,
  toolSchemas: [],
  builtinTools: [],
  allowedHosts: [],
};

function makeSandboxOptions(
  sessionStates: ReturnType<typeof createMemorySessionStateStore>,
  slug = "test-agent",
): SandboxOptions {
  return {
    workerCode: 'export default { name: "test" };',
    env: {},
    slug,
    agentConfig: { ...TEST_AGENT_CONFIG, name: slug },
    defaultVector: (s) => createMemoryVector({ namespace: s }),
    sessionStates,
  };
}

/** Minimal client-session WebSocket double with manually firable events. */
function makeSessionWs() {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener(type: string, cb: (ev?: unknown) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  return {
    ws,
    fire(type: string, ev?: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    },
  };
}

/** Open a session and resolve its server-assigned id. */
function openSession(
  sandbox: ReturnType<typeof createSandbox>,
  opts?: { resumeFrom?: string },
): { sid: string; fire: (type: string, ev?: unknown) => void } {
  let sid: string | undefined;
  const { ws, fire } = makeSessionWs();
  sandbox.startSession(ws as never, {
    ...(opts?.resumeFrom ? { resumeFrom: opts.resumeFrom } : {}),
    onSinkCreated: (id) => {
      sid = id;
    },
  });
  if (!sid) throw new Error("session did not open");
  return { sid, fire };
}

describe("cross-replica session resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guests.length = 0;
    mockCreateSandboxVm.mockImplementation(() => {
      const guest = makeFakeGuest();
      guests.push(guest);
      return Promise.resolve({
        conn: guest.conn,
        shutdown: vi.fn().mockResolvedValue(undefined),
      });
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("persists guest ctx.state and remember notes on disconnect", async () => {
    const store = createMemorySessionStateStore();
    const replicaA = createSandbox(makeSandboxOptions(store));
    const { sid, fire } = openSession(replicaA);

    // Stand-ins for what a real session accumulates: a custom tool mutated
    // its guest-side ctx.state, and the remember builtin saved a note
    // host-side.
    await vi.advanceTimersByTimeAsync(0); // let vmReady settle
    guests[0]?.state.set(sid, { cart: ["pizza"] });
    restoreSessionNotes(sid, { user_id: "u-42" });

    fire("close", { code: 1000, reason: "client gone" });
    await vi.advanceTimersByTimeAsync(0);

    await expect(store.load("test-agent", sid)).resolves.toEqual({
      state: { cart: ["pizza"] },
      notes: { user_id: "u-42" },
    });
    await replicaA.shutdown();
  });

  it("a resume landing on a different replica hydrates the guest state", async () => {
    const store = createMemorySessionStateStore();

    // Replica A: session runs, accumulates state, client disconnects.
    const replicaA = createSandbox(makeSandboxOptions(store));
    const a = openSession(replicaA);
    await vi.advanceTimersByTimeAsync(0);
    guests[0]?.state.set(a.sid, { step: "payment", order_id: "o-7" });
    a.fire("close", { code: 1006, reason: "replica died" });
    await vi.advanceTimersByTimeAsync(0);
    await replicaA.shutdown();

    // Replica B: fresh sandbox, fresh guest, same store — the reconnect
    // lands here with ?sessionId=<id>.
    const replicaB = createSandbox(makeSandboxOptions(store));
    openSession(replicaB, { resumeFrom: a.sid });
    await vi.advanceTimersByTimeAsync(0);

    expect(guests[1]?.state.get(a.sid)).toEqual({ step: "payment", order_id: "o-7" });
    await replicaB.shutdown();
  });

  it("restores remember notes on the resuming replica", async () => {
    const store = createMemorySessionStateStore();
    // Seed the store directly — in production this row was written by the
    // replica that owned the session before it died. A fresh session id
    // guarantees the resuming process has no live notes entry.
    const sid = `resume-notes-${crypto.randomUUID()}`;
    await store.save("test-agent", sid, { notes: { reservation: "R-19" } });

    const replicaB = createSandbox(makeSandboxOptions(store));
    const { ws } = makeSessionWs();
    replicaB.startSession(ws as never, { resumeFrom: sid });
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshotSessionNotes(sid)).toEqual({ reservation: "R-19" });
    await replicaB.shutdown();
  });

  it("never hydrates another agent's session state (slug scoping)", async () => {
    const store = createMemorySessionStateStore();
    const sid = `cross-agent-${crypto.randomUUID()}`;
    await store.save("other-agent", sid, { state: { secret: "not yours" } });

    const replicaB = createSandbox(makeSandboxOptions(store, "test-agent"));
    const { ws } = makeSessionWs();
    replicaB.startSession(ws as never, { resumeFrom: sid });
    await vi.advanceTimersByTimeAsync(0);

    expect(guests[0]?.state.has(sid)).toBe(false);
    await replicaB.shutdown();
  });

  it("shutdown waits for in-flight persists (drain-deadline closes)", async () => {
    const store = createMemorySessionStateStore();
    const replicaA = createSandbox(makeSandboxOptions(store));
    const { sid, fire } = openSession(replicaA);
    await vi.advanceTimersByTimeAsync(0);
    guests[0]?.state.set(sid, { mid: "call" });

    // Drain-deadline shutdown: the socket close and the sandbox shutdown
    // land back to back, with no timer ticks between them.
    fire("close", { code: 1001, reason: "going away" });
    await replicaA.shutdown();

    await expect(store.load("test-agent", sid)).resolves.toEqual({ state: { mid: "call" } });
  });

  it("a sandbox without a store keeps today's replica-local behavior", async () => {
    const replicaA = createSandbox({
      ...makeSandboxOptions(createMemorySessionStateStore()),
      sessionStates: undefined,
    });
    const { sid, fire } = openSession(replicaA);
    await vi.advanceTimersByTimeAsync(0);
    guests[0]?.state.set(sid, { x: 1 });
    fire("close", { code: 1000, reason: "bye" });
    await vi.advanceTimersByTimeAsync(0);
    // No export RPC went out.
    const conn = guests[0]?.conn as NdjsonConnection;
    expect(conn.sendRequest).not.toHaveBeenCalledWith("session/export", expect.anything());
    await replicaA.shutdown();
  });
});
