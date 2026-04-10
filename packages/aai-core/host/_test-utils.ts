// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNanoEvents } from "nanoevents";
import { vi } from "vitest";
import type { AgentConfig } from "../isolate/_internal-types.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import type { AgentDef, ToolContext, ToolDef } from "../isolate/types.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../isolate/types.ts";
import { createRuntime } from "./runtime.ts";
import type { S2sEvents, S2sHandle } from "./s2s.ts";
import type { Session } from "./session.ts";
import { _internals, type S2sSessionOptions } from "./session.ts";

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
  "transcript.user.delta": (h, m) =>
    h._fire("event", { type: "user_transcript", text: m.text as string, isFinal: false }),
  "transcript.user": (h, m) =>
    h._fire("event", { type: "user_transcript", text: m.text as string, isFinal: true }),
  "reply.started": (h, m) => h._fire("replyStarted", { replyId: (m.reply_id as string) ?? "" }),
  "transcript.agent.delta": (h, m) =>
    h._fire("event", {
      type: "agent_transcript",
      text: (m.delta as string) ?? "",
      isFinal: false,
    }),
  "transcript.agent": (h, m) =>
    h._fire("event", {
      type: "agent_transcript",
      text: (m.text as string) ?? "",
      isFinal: true,
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
