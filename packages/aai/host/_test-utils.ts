// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import type { AgentConfig } from "../sdk/_internal-types.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { AgentDef, ToolContext, ToolDef } from "../sdk/types.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import { createRuntime } from "./runtime.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle } from "./s2s.ts";
import type { SessionCore } from "./session-core.ts";
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

// ─── SessionCore mock ───────────────────────────────────────────────────────

/** Create a SessionCore-shaped mock with all methods as vi.fn() spies. */
export function makeMockCore(overrides?: Partial<SessionCore>): SessionCore {
  return {
    id: "test",
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    onAudio: vi.fn(),
    onAudioReady: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onHistory: vi.fn(),
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    ...overrides,
  };
}

// ─── S2sHandle mock ─────────────────────────────────────────────────────────

/** Create a mock S2sHandle backed by vi.fn() spies. */
export function makeMockHandle(): S2sHandle {
  return {
    sendAudio: vi.fn(),
    sendAudioRaw: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
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

// ─── Fixture replay helpers ──────────────────────────────────────────────────

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

/** Load a JSON fixture from fixtures/. */
export function loadFixture<T = Record<string, unknown>[]>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf-8"));
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
