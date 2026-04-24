// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNanoEvents } from "nanoevents";
import { vi } from "vitest";
import type { AgentConfig } from "../sdk/_internal-types.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { AgentDef, ToolContext, ToolDef } from "../sdk/types.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import { createRuntime } from "./runtime.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sEvents, S2sHandle } from "./s2s.ts";
import type { Session } from "./session.ts";
import { _internals, type S2sSessionOptions } from "./session.ts";
import { _internals as s2sTransportInternals } from "./transports/s2s-transport.ts";

/** Yield to the microtask queue so pending promises settle. */
export function flush(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(r));
}

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    state: {},
    kv: {} as never,
    messages: [],
    sessionId: "test-session",
    send: vi.fn(),
    ...overrides,
  };
}

export function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return { description: "test tool", execute: () => "ok", ...overrides };
}

export function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  return {
    name: "test-agent",
    systemPrompt: "Be helpful.",
    greeting: "Hello!",
    maxSteps: 5,
    tools: {},
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

/** Create a stub Session with all methods as vi.fn() spies. */
export function makeStubSession(overrides?: Partial<Session>): Session {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    onAudio: vi.fn(),
    onAudioReady: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onHistory: vi.fn(),
    waitForTurn: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

// ─── Session test helpers ───────────────────────────────────────────────────

export type MockS2sHandle = S2sHandle & {
  _fire: <K extends keyof S2sEvents>(type: K, ...args: Parameters<S2sEvents[K]>) => void;
};

/** Create a mock S2sHandle backed by nanoevents. */
export function makeMockHandle(): MockS2sHandle {
  const emitter = createNanoEvents<S2sEvents>();
  return {
    on: emitter.on.bind(emitter),
    sendAudio: vi.fn(),
    sendAudioRaw: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
    _fire<K extends keyof S2sEvents>(type: K, ...args: Parameters<S2sEvents[K]>) {
      emitter.emit(type, ...args);
    },
  };
}

/** Minimal client that tracks events and audio. All methods are vi.fn() spies. */
export function makeClient(): ClientSink & {
  events: unknown[];
  audioChunks: Uint8Array[];
  audioDoneCount: number;
} {
  const events: unknown[] = [];
  const audioChunks: Uint8Array[] = [];
  let audioDoneCount = 0;
  return {
    open: true,
    events,
    audioChunks,
    get audioDoneCount() {
      return audioDoneCount;
    },
    event: vi.fn((e: unknown) => {
      events.push(e);
    }),
    playAudioChunk: vi.fn((chunk: Uint8Array) => {
      audioChunks.push(chunk);
    }),
    playAudioDone: vi.fn(() => {
      audioDoneCount++;
    }),
  };
}

/**
 * Minimal ClientSink stub that satisfies the new interface.
 * All methods are vi.fn() spies. Use in tests that need a valid ClientSink
 * but don't need to inspect event payloads (e.g. routing / creation tests).
 */
export function makeClientSink(overrides?: Partial<ClientSink>): ClientSink {
  return {
    open: true,
    config: vi.fn(),
    audio: vi.fn(),
    audioDone: vi.fn(),
    speechStarted: vi.fn(),
    speechStopped: vi.fn(),
    userTranscript: vi.fn(),
    agentTranscript: vi.fn(),
    toolCall: vi.fn(),
    toolCallDone: vi.fn(),
    replyDone: vi.fn(),
    cancelled: vi.fn(),
    reset: vi.fn(),
    idleTimeout: vi.fn(),
    error: vi.fn(),
    customEvent: vi.fn(),
    ...overrides,
  };
}

export const silentLogger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
} = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export function makeSessionOpts(overrides?: Partial<S2sSessionOptions>): S2sSessionOptions {
  return {
    id: "session-1",
    agent: "test-agent",
    client: makeClient(),
    agentConfig: {
      name: "test-agent",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      greeting: "Hello!",
    },
    toolSchemas: [],
    apiKey: "test-key",
    s2sConfig: {
      wssUrl: "wss://fake",
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
    },
    executeTool: vi.fn(async () => "tool-result"),
    createWebSocket: vi.fn(),
    logger: silentLogger,
    ...overrides,
  };
}

// ─── Fixture replay helpers ──────────────────────────────────────────────────

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

/** Load a JSON fixture from fixtures/. */
export function loadFixture<T = Record<string, unknown>[]>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf-8"));
}

/**
 * Wire-format → event translator: maps a single raw S2S API message to
 * a `_fire()` call on the mock handle.  Returns false if the message
 * type is not dispatchable (audio, content_part, unknown).
 */
type FireFn = (handle: MockS2sHandle, msg: Record<string, unknown>) => void;

const FIXTURE_DISPATCH: Record<string, FireFn> = {
  "session.ready": (h, m) => h._fire("ready", { sessionId: m.session_id as string }),
  "session.updated": () => {
    /* dropped — no longer dispatched */
  },
  "session.error": (h, m) => {
    const code = m.code as string;
    if (code === "session_not_found" || code === "session_forbidden") h._fire("sessionExpired");
    else h._fire("error", new Error(m.message as string));
  },
  error: (h, m) => h._fire("error", new Error(m.message as string)),
  "input.speech.started": (h) => h._fire("event", { type: "speech_started" }),
  "input.speech.stopped": (h) => h._fire("event", { type: "speech_stopped" }),
  "transcript.user": (h, m) =>
    h._fire("event", { type: "user_transcript", text: m.text as string }),
  "reply.started": (h, m) => h._fire("replyStarted", { replyId: (m.reply_id as string) ?? "" }),
  "transcript.agent": (h, m) =>
    h._fire("event", {
      type: "agent_transcript",
      text: (m.text as string) ?? "",
      _interrupted: m.interrupted === true,
    }),
  "tool.call": (h, m) =>
    h._fire("event", {
      type: "tool_call",
      toolCallId: m.call_id as string,
      toolName: m.name as string,
      args: (m.args as Record<string, unknown>) ?? {},
    }),
  "reply.done": (h, m) => {
    if (m.status === "interrupted") h._fire("event", { type: "cancelled" });
    else h._fire("event", { type: "reply_done" });
  },
};

/**
 * Replay recorded S2S API messages through a MockS2sHandle.
 *
 * Converts raw wire-format JSON (from fixtures/) into typed `_fire()` calls.
 * This is the inverse of `dispatchS2sMessage` in s2s.ts — it translates
 * snake_case API fields to camelCase event payloads.
 *
 * Messages that don't map to an event (audio, `reply.content_part.*`) are skipped.
 */
export function replayFixtureMessages(
  handle: MockS2sHandle,
  messages: Record<string, unknown>[],
): void {
  for (const msg of messages) {
    FIXTURE_DISPATCH[msg.type as string]?.(handle, msg);
  }
}

// ─── Real-executor fixture replay ────────────────────────────────────────────

/**
 * Create a real Runtime-backed session for fixture replay testing.
 *
 * Uses a real `Runtime` (real tool execution, real hooks) but replaces the
 * S2S WebSocket with a mock handle so fixture messages can be replayed
 * through the full orchestration layer.
 *
 * Exercises: AgentDef → toAgentConfig → tool schemas → Zod arg validation
 * → executeToolCall → session orchestration (reply guards, tool buffering,
 * turnPromise chaining).
 *
 * Call `cleanup()` when done to restore the connectS2s spy.
 */
export function createFixtureSession(
  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts any agent state type
  agent: AgentDef<any>,
  opts?: { env?: Record<string, string> },
) {
  const mockHandle = makeMockHandle();
  const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);
  const client = makeClient();

  const executor = createRuntime({
    agent,
    env: opts?.env ?? {},
    logger: silentLogger,
  });

  const session = executor.createSession({
    id: "fixture-session",
    agent: agent.name,
    client,
  });

  return {
    session,
    client,
    mockHandle,
    executor,
    /** Replay a fixture file through the session's S2S handle. */
    replay(fixtureName: string) {
      replayFixtureMessages(mockHandle, loadFixture(fixtureName));
    },
    /** Restore the connectS2s spy. Call in afterEach. */
    cleanup() {
      connectSpy.mockRestore();
    },
  };
}

// ─── V2 fixture session helpers (transport-layer spy) ───────────────────────

/**
 * A tracking ClientSink that records all calls into typed arrays for easy
 * test assertions. Compatible with makeClientSink() but with inspection APIs.
 */
export type TrackingClientSink = ClientSink & {
  agentTranscripts: string[];
  userTranscripts: string[];
  toolCallEvents: { callId: string; name: string; args: unknown }[];
  audioChunks: Uint8Array[];
  replyDoneCount: number;
  cancelledCount: number;
  speechStartedCount: number;
  speechStoppedCount: number;
};

export function makeTrackingClient(): TrackingClientSink {
  const agentTranscripts: string[] = [];
  const userTranscripts: string[] = [];
  const toolCallEvents: { callId: string; name: string; args: unknown }[] = [];
  const audioChunks: Uint8Array[] = [];
  let replyDoneCount = 0;
  let cancelledCount = 0;
  let speechStartedCount = 0;
  let speechStoppedCount = 0;

  return {
    open: true,
    agentTranscripts,
    userTranscripts,
    toolCallEvents,
    audioChunks,
    get replyDoneCount() {
      return replyDoneCount;
    },
    get cancelledCount() {
      return cancelledCount;
    },
    get speechStartedCount() {
      return speechStartedCount;
    },
    get speechStoppedCount() {
      return speechStoppedCount;
    },
    config: vi.fn(),
    audio: vi.fn((chunk: Uint8Array) => {
      audioChunks.push(chunk);
    }),
    audioDone: vi.fn(),
    speechStarted: vi.fn(() => {
      speechStartedCount++;
    }),
    speechStopped: vi.fn(() => {
      speechStoppedCount++;
    }),
    userTranscript: vi.fn((text: string) => {
      userTranscripts.push(text);
    }),
    agentTranscript: vi.fn((text: string) => {
      agentTranscripts.push(text);
    }),
    toolCall: vi.fn((callId: string, name: string, args: unknown) => {
      toolCallEvents.push({ callId, name, args });
    }),
    toolCallDone: vi.fn(),
    replyDone: vi.fn(() => {
      replyDoneCount++;
    }),
    cancelled: vi.fn(() => {
      cancelledCount++;
    }),
    reset: vi.fn(),
    idleTimeout: vi.fn(),
    error: vi.fn(),
    customEvent: vi.fn(),
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
 * Create a real Runtime-backed session for fixture replay testing (V2).
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
export function createFixtureSessionV2(
  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts any agent state type
  agent: AgentDef<any>,
  opts?: { env?: Record<string, string> },
) {
  let capturedCallbacks: S2sCallbacks | null = null;
  const fakeHandle: S2sHandle = {
    sendAudio: vi.fn(),
    sendAudioRaw: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
  };

  const connectSpy = vi
    .spyOn(s2sTransportInternals, "connectS2s")
    .mockImplementation(async (connectOpts: ConnectS2sOptions) => {
      capturedCallbacks = connectOpts.callbacks;
      return fakeHandle;
    });

  const client = makeTrackingClient();
  const executor = createRuntime({
    agent,
    env: opts?.env ?? {},
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
    /** Restore the connectS2s spy. Call in afterEach. */
    cleanup() {
      connectSpy.mockRestore();
    },
  };
}
