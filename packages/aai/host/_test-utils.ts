// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import type { AgentConfig } from "../sdk/_internal-types.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { assemblyAIS2s } from "../sdk/providers/s2s/assemblyai.ts";
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

/** Sleep real wall-clock ms. Prefer fake timers or `vi.waitFor` where possible. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    state: {},
    db: {} as never,
    generate: () => Promise.reject(new Error("generate not mocked")),
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
    onPlaybackProgress: vi.fn(),
    onHistory: vi.fn(),
    onToolResult: vi.fn(),
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onUserTranscriptPartial: vi.fn(),
    onAgentTranscript: vi.fn(),
    onAgentTranscriptPartial: vi.fn(),
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
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
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
    playAudioDone: vi.fn(),
    ...overrides,
  };
}

export const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * Fresh logger with per-call `vi.fn()` spies. Use for tests that assert on
 * log output — {@link silentLogger} is a shared singleton and accumulates
 * call history across tests.
 */
export function makeLogger() {
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
  events: ClientEvent[];
};

export function makeTrackingClient(): TrackingClientSink {
  const agentTranscripts: string[] = [];
  const userTranscripts: string[] = [];
  const toolCallEvents: { callId: string; name: string; args: unknown }[] = [];
  const audioChunks: Uint8Array[] = [];
  const events: ClientEvent[] = [];

  function countByType(type: ClientEvent["type"]): number {
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
      return countByType("reply_done");
    },
    get cancelledCount() {
      return countByType("cancelled");
    },
    get speechStartedCount() {
      return countByType("speech_started");
    },
    get speechStoppedCount() {
      return countByType("speech_stopped");
    },
    event: vi.fn((e: ClientEvent) => {
      events.push(e);
      switch (e.type) {
        case "agent_transcript":
          agentTranscripts.push(e.text);
          break;
        case "user_transcript":
          userTranscripts.push(e.text);
          break;
        case "tool_call":
          toolCallEvents.push({ callId: e.toolCallId, name: e.toolName, args: e.args });
          break;
        default:
          break;
      }
    }),
    playAudioChunk: vi.fn((chunk: Uint8Array) => {
      audioChunks.push(chunk);
    }),
    playAudioDone: vi.fn(),
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
export function createFixtureSession(
  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts any agent state type
  agent: AgentDef<any>,
  opts?: { env?: Record<string, string> },
) {
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
  };
}
