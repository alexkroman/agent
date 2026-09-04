// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentDef, ToolContext, ToolDef } from "@alexkroman1/aai";
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { createDetachedSlotStore, rejectingWorkflows } from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { omitUndefined } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import { type Mock, vi } from "vitest";
import { createRuntime } from "./runtime.ts";
import { type LogFn, type Logger, type LogLevel, silentLogger } from "./runtime-config.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle } from "./s2s.ts";
import type { ServerSession } from "./session-core.ts";
import {
  createSessionEmitter,
  type SessionEmitter,
  type SessionEventHookDeps,
} from "./session-emitter.ts";
import { createSessionEventStream, type SessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend } from "./session-state-store.ts";
import { _internals as s2sTransportInternals } from "./transports/s2s-transport.ts";

/** Yield to the microtask queue so pending promises settle. */
export function flush(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(r));
}

/**
 * Yield a full MACROTASK — drains microtasks and also lets already-scheduled
 * zero-delay timers and I/O callbacks run.
 *
 * Deliberately not called `flush`: several specs had a local
 * `const flush = () => new Promise(r => setTimeout(r, 0))` that SHADOWED the
 * microtask `flush` above, so the same identifier meant two different waits
 * depending on the file you were reading. Pick by what you need to drain, not
 * by which one happens to be in scope.
 */
export function tick(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/**
 * Sleep real wall-clock ms. Prefer fake timers or `vi.waitFor` where possible.
 *
 * Re-exported rather than re-implemented: this was a fourth copy of the repo's
 * one `sleep`, and being spelled here is what let `vi.useFakeTimers()` drive it
 * — a property the shared one now owns and asserts. See `sdk/sleep.ts`.
 */
export { sleep } from "@alexkroman1/aai/host-internal";

/**
 * Settle `promise`, or fail with a sentence naming what never happened.
 *
 * A socket helper that resolves only on the frame it is waiting for turns a
 * regression — an error reported without closing the socket, a handshake frame
 * silently dropped — into a bare TIER TIMEOUT: the whole file is named, no
 * assertion is, and the reader learns nothing. Wrap the wait and the failure
 * says which one it was.
 *
 * `p-timeout` rather than a hand-rolled `Promise.race` against a timer
 * (`guard-invariants` rule 3): the losing branch's late rejection and the
 * timer cleanup are exactly what gets re-derived wrong.
 *
 * `what` may be a thunk, so a message can report what HAD arrived by the
 * deadline — the half of the diagnosis a fixed string cannot carry.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  what: string | (() => string),
  ms = 2000,
): Promise<T> {
  return pTimeout(promise, {
    milliseconds: ms,
    fallback: () => {
      throw new Error(`${typeof what === "function" ? what() : what} within ${ms}ms`);
    },
  });
}

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    slots: createDetachedSlotStore(),
    // The SDK's own published helper rather than `{} as never`: it REJECTS
    // naming itself, so a spec that unexpectedly reaches `ctx.db` says so
    // instead of dying on a TypeError against an empty object. `as never` is
    // assignable to every position and stops reporting when `Db` grows a
    // method — the laundering idiom the escape-hatch ratchet now counts.
    generate: () => Promise.reject(new Error("generate not mocked")),
    delegate: () => Promise.reject(new Error("delegate not mocked")),
    messages: [],
    sessionId: "test-session",
    send: vi.fn(),
    // Rejects rather than no-ops: a spec that reaches `ctx.workflows` without
    // stubbing one is asserting against a fake, and the message says so.
    workflows: rejectingWorkflows("ctx.workflows not mocked"),
    // A signal that never aborts — `ToolContext.signal` is non-optional, and
    // "this context cannot cancel" is spelled as a live-forever signal rather
    // than as an absent field.
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return { description: "test tool", execute: () => "ok", ...overrides };
}

export function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  // Most host suites exercise the S2S transport through a mocked WebSocket,
  // and pre-dated the pipeline-by-default flip. Keep them on S2S explicitly
  // (the descriptor the flip requires) unless the caller declares providers.
  const declaresProviders =
    overrides != null &&
    (overrides.stt != null ||
      overrides.llm != null ||
      overrides.tts != null ||
      overrides.s2s != null);
  return {
    name: "test-agent",
    systemPrompt: "Be helpful.",
    greeting: "Hello!",
    maxSteps: 5,
    tools: {},
    ...(declaresProviders ? {} : { s2s: assemblyAIS2s() }),
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: "Hello",
    ...overrides,
  };
}

// ─── ServerSession mock ───────────────────────────────────────────────────────

/**
 * Create a ServerSession-shaped mock with all methods as vi.fn() spies.
 *
 * Nine spies, where there were twenty-four. The session's inbound surface is two
 * vocabularies plus two audio paths now (see `session-core.ts`), so this stub
 * cannot go stale against an added command or event the way a per-name one did —
 * which is the whole reason a double cast to `ServerSession` was tempting here, and
 * a cast is exactly what stops reporting when a field is ADDED.
 */
export function makeMockCore(overrides?: Partial<ServerSession>): ServerSession {
  return {
    id: "test",
    // A healthy session by default, so an override is what options a spec into the
    // fault path. Not a spy: it is a readonly value on the real type.
    faultCode: undefined,
    configure: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    announce: vi.fn(() => true),
    restoreHistory: vi.fn(),
    command: vi.fn(),
    onAudio: vi.fn(),
    report: vi.fn(),
    onReplyStarted: vi.fn(),
    onAudioChunk: vi.fn(),
    ...overrides,
  };
}

// ─── S2sHandle mock ─────────────────────────────────────────────────────────

/** Create a mock S2sHandle backed by vi.fn() spies. */
export function makeMockHandle(): S2sHandle {
  return {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
  };
}

/**
 * A real {@link SessionEmitter} over a real stream on the memory backend — what a
 * spec passes as `createSessionCore({ emitter })`.
 *
 * REAL rather than a `vi.fn()` for the reason the memory state backend is a valid
 * double for the Postgres one: the stamping, the index assignment and the
 * client-then-hooks ordering are the emitter's whole content, and a stub would
 * assert none of it while every session spec ran through it. Assert on the SINK
 * for what the client saw, and read `stream` here for what was recorded.
 */
export function makeEmitter(
  client: ClientSink,
  options?: { sessionId?: string; hooks?: SessionEventHookDeps },
): { emitter: SessionEmitter; stream: SessionEventStream; sessionId: string } {
  const sessionId = options?.sessionId ?? "test-session";
  const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
  return {
    emitter: createSessionEmitter({
      sessionId,
      client,
      stream,
      ...omitUndefined({ hooks: options?.hooks }),
    }),
    stream,
    sessionId,
  };
}

/**
 * Minimal ClientSink stub that satisfies the 3-method interface.
 * All methods are vi.fn() spies. Use in tests that need a valid ClientSink
 * but don't need to inspect event payloads (e.g. routing / creation tests).
 */
export function makeClientSink(overrides?: Partial<ClientSink>): ClientSink {
  return {
    open: true,
    event: vi.fn(),
    playAudioChunk: vi.fn(),
    ...overrides,
  };
}

/**
 * A logger that discards. Shared by 26 suites purely to keep test output
 * quiet — it is NOT for asserting on.
 *
 * Re-exported rather than declared: `runtime-config.ts` owns the one silent
 * logger now, beside `consoleLogger`, because the fuzz harnesses need the same
 * value and may not import this file (its vitest-backed helpers are not
 * declaration-portable). Kept under this name so the 26 suites already
 * importing it do not all have to move.
 *
 * The value is plain no-ops rather than `vi.fn()`, which is the point and is
 * argued at the declaration: as spies these were a module singleton whose call
 * history accumulated across every test in a file (`restoreMocks` restores
 * spies, it does not clear a `vi.fn()`'s call log), so
 * `expect(silentLogger.error).toHaveBeenCalled()` could be satisfied by an
 * error some earlier test logged. Two suites were asserting on it.
 */
export { silentLogger } from "./runtime-config.ts";

/**
 * Narrow a test double to `fetch`'s type, in ONE place.
 *
 * A fake fetch never matches `typeof globalThis.fetch` structurally — the real
 * signature takes `RequestInfo | URL`, returns a full `Response`, and carries
 * `preconnect` — so every call site was laundering its double through a
 * double-cast to get there. That is the concentration of identical casts the
 * root guide names as a missing typed seam: 27 of them across four suites
 * here. The narrowing happens once, below, and the call sites read as what
 * they are.
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

/**
 * A {@link Logger} whose four methods are spies.
 *
 * DECLARED rather than inferred, and that is load-bearing: `vi.fn()`'s type
 * mentions `Procedure` from `@vitest/spy`, which the declaration emit under
 * `tsconfig.build.json` cannot name from here (`TS2883`) — so an inferred
 * return type on an exported helper breaks the BUILD while `tsc --noEmit`
 * stays green. Both halves of the shape are needed: `Mock<LogFn>` for
 * `.mock.calls` / `toHaveBeenCalledWith`, and `Logger` so it is assignable to
 * `createRuntime({ logger })` without a cast.
 */
export type TestLogger = Record<LogLevel, Mock<LogFn>> & Logger;

/** Fresh logger with per-call `vi.fn()` spies. Use whenever you assert on log output. */
export function makeLogger(): TestLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// ─── Fixture replay helpers ──────────────────────────────────────────────────

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

/** Load a JSON fixture from fixtures/. */
export function loadFixture<T = Record<string, unknown>[]>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf-8"));
}

// ─── Fixture session helpers (transport-layer spy) ──────────────────────────

/**
 * A tracking ClientSink that records all calls into typed arrays for easy
 * test assertions. Compatible with makeClientSink() but with inspection APIs.
 * Uses the 3-method sink interface — event() dispatches are tracked by type.
 */
export type TrackingClientSink = ClientSink & {
  agentTranscripts: string[];
  userTranscripts: string[];
  toolCallEvents: { callId: string; name: string; args: unknown }[];
  audioChunks: Uint8Array[];
  readonly replyDoneCount: number;
  readonly cancelledCount: number;
  readonly speechStartedCount: number;
  readonly speechStoppedCount: number;
  events: SessionEvent[];
};

export function makeTrackingClient(): TrackingClientSink {
  const agentTranscripts: string[] = [];
  const userTranscripts: string[] = [];
  const toolCallEvents: { callId: string; name: string; args: unknown }[] = [];
  const audioChunks: Uint8Array[] = [];
  const events: SessionEvent[] = [];

  function countByType(type: SessionEvent["type"]): number {
    let n = 0;
    for (const e of events) if (e.type === type) n++;
    return n;
  }

  return {
    open: true,
    agentTranscripts,
    userTranscripts,
    toolCallEvents,
    audioChunks,
    events,
    get replyDoneCount() {
      return countByType("reply.completed");
    },
    get cancelledCount() {
      return countByType("reply.cancelled");
    },
    get speechStartedCount() {
      return countByType("speech.started");
    },
    get speechStoppedCount() {
      return countByType("speech.stopped");
    },
    event: vi.fn((e: SessionEvent) => {
      events.push(e);
      switch (e.type) {
        // Both: an interim snapshot and the reply's committed text. They are
        // separate events now (only the second enters history), and a recorder
        // that took one would have stopped seeing whole replies.
        case "agent-transcript.updated":
        case "agent-transcript.committed":
          agentTranscripts.push(e.text);
          break;
        case "user-transcript.committed":
          userTranscripts.push(e.text);
          break;
        case "tool.called":
          toolCallEvents.push({ callId: e.toolCallId, name: e.toolName, args: e.args });
          break;
        default:
          break;
      }
    }),
    playAudioChunk: vi.fn((chunk: Uint8Array) => {
      audioChunks.push(chunk);
    }),
  };
}

/**
 * Translate a single fixture wire-format message directly into S2sCallbacks calls.
 * This is the callback-based equivalent of the old FIXTURE_DISPATCH / replayFixtureMessages.
 */
export function fireFixtureMessage(callbacks: S2sCallbacks, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "session.ready":
      callbacks.onSessionReady(msg.session_id as string);
      break;
    case "session.updated":
      break; // no callback
    case "reply.started":
      callbacks.onReplyStarted(msg.reply_id as string);
      break;
    case "reply.done":
      if (msg.status === "interrupted") callbacks.onCancelled();
      else callbacks.onReplyDone();
      break;
    case "transcript.user":
      callbacks.onUserTranscript(msg.text as string);
      break;
    case "transcript.agent":
      callbacks.onAgentTranscript(msg.text as string, Boolean(msg.interrupted));
      break;
    case "tool.call":
      callbacks.onToolCall(
        msg.call_id as string,
        msg.name as string,
        (msg.args ?? {}) as Record<string, unknown>,
      );
      break;
    case "input.speech.started":
      callbacks.onSpeechStarted();
      break;
    case "input.speech.stopped":
      callbacks.onSpeechStopped();
      break;
    case "session.error": {
      const code = msg.code as string;
      if (code === "session_not_found" || code === "session_forbidden")
        callbacks.onSessionExpired();
      else callbacks.onError(new Error((msg.message ?? "session error") as string));
      break;
    }
    case "error":
      callbacks.onError(new Error((msg.message ?? "error") as string));
      break;
    case "reply.audio":
      break; // skip — audio tested separately
    default:
      break;
  }
}

/**
 * Create a real Runtime-backed session for fixture replay testing.
 *
 * Spies on s2s-transport.ts `_internals.connectS2s` (the transport-layer seam
 * added in Task 15) so that captured S2sCallbacks can be fired directly —
 * no nanoevents, no old S2sEvents system.
 *
 * Call `await ctx.start()` first to trigger the spy, then `ctx.replay(name)`
 * or fire `ctx.mockCallbacks.on*` directly.
 *
 * Call `cleanup()` in afterEach to restore the spy.
 */
export function createFixtureSession(agent: AgentDef, options?: { env?: Record<string, string> }) {
  let capturedCallbacks: S2sCallbacks | null = null;
  const fakeHandle = makeMockHandle();

  // No teardown to return: vitest's `restoreMocks` restores every spy before
  // each test (see vitest.shared.ts).
  vi.spyOn(s2sTransportInternals, "connectS2s").mockImplementation(
    async (connectOpts: ConnectS2sOptions) => {
      capturedCallbacks = connectOpts.callbacks;
      return fakeHandle;
    },
  );

  const client = makeTrackingClient();
  const executor = createRuntime({
    // This helper replays the AssemblyAI S2S protocol (it spies the S2S
    // transport seam), so pin the agent to S2S mode — the descriptor the
    // pipeline-by-default flip requires — unless it declared providers.
    agent:
      agent.stt != null || agent.llm != null || agent.tts != null || agent.s2s != null
        ? agent
        : { ...agent, s2s: assemblyAIS2s() },
    env: options?.env ?? {},
    logger: silentLogger,
  });

  const session = executor.createSession({
    id: "fixture-session",
    agent: agent.name,
    client,
  });

  function getCallbacks(): S2sCallbacks {
    if (!capturedCallbacks) throw new Error("must call start() before accessing callbacks");
    return capturedCallbacks;
  }

  return {
    session,
    client,
    fakeHandle,
    executor,
    /** Trigger transport.start() — fires the connectS2s spy and captures callbacks. */
    async start() {
      await session.start();
      if (!capturedCallbacks) throw new Error("connectS2s was never called during start()");
    },
    /** Direct access to the captured S2sCallbacks for manual event firing. */
    get mockCallbacks(): S2sCallbacks {
      return getCallbacks();
    },
    /** Replay a fixture file by translating each message to S2sCallbacks calls. */
    replay(fixtureName: string) {
      const cbs = getCallbacks();
      for (const msg of loadFixture(fixtureName)) {
        fireFixtureMessage(cbs, msg as Record<string, unknown>);
      }
    },
  };
}

/** One statement a fake `Db` was asked to run. */
export type IssuedStatement = { sql: string; params: unknown[] };

/** A fake `Db` that records every statement and answers reads from a queue. */
export type RecordingDb = Db & {
  /** Every statement issued, in order, with the parameters it was bound to. */
  readonly issued: IssuedStatement[];
  /** The same statements as bare SQL, for a caller that asserts on shape only. */
  readonly sql: string[];
};

/**
 * A `Db` that records what it was asked and answers from a queue of rows.
 *
 * The narrowing below is the ONE unavoidable cast in this shape, and it is here
 * so there is exactly one of it. `Db.query<T>` lets the CALLER name the row
 * type, so no runtime queue can satisfy an arbitrary `T` — a fake for a generic
 * read is a cast by construction. What is avoidable is a copy of it per suite:
 * `workflow-keys.test.ts` and `workflow-journal-postgres.test.ts` had written
 * the same eight lines, each laundering through its own `as never`, which is
 * the pattern this repo counts precisely because it multiplies.
 *
 * `rows` is consumed IN ORDER, so a method that writes and then reads back —
 * `appendStep`, `claimSleep`, `claimHook` all have that shape — gets its read
 * answered by the next entry.
 */
export function recordingDb(rows: readonly Record<string, unknown>[][] = []): RecordingDb {
  const issued: IssuedStatement[] = [];
  const queue = [...rows];
  return {
    issued,
    get sql() {
      return issued.map((statement) => statement.sql);
    },
    // A plain function rather than `vi.fn`: the mock wrapper erases the generic
    // (`Mock` fixes `T` at declaration), and `issued` is already the recording
    // a spy would have provided.
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      issued.push({ sql, params });
      return (queue.shift() ?? []) as T[];
    },
  };
}
