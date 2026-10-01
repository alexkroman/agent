// Copyright 2025 the AAI authors. MIT license.

/**
 * Session-side doubles: a `ServerSession` of spies, a real emitter over the
 * memory backend, and client sinks (plain and recording).
 */

import type { SessionEvent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { vi } from "vitest";
import {
  createSessionEmitter,
  createSessionEventStream,
  type ServerSession,
  type SessionEmitter,
  type SessionEventHookDeps,
  type SessionEventStream,
} from "./session/index.ts";
import { createMemoryStateBackend } from "./session-state/store.ts";

/**
 * A `ServerSession` whose methods are `vi.fn()` spies. Typed against the real
 * interface rather than cast, so an added field is a compile error here.
 */
export function makeMockCore(overrides?: Partial<ServerSession>): ServerSession {
  return {
    id: "test",
    // Healthy by default; an override opts a spec into the fault path.
    faultCode: undefined,
    configure: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    announce: vi.fn(() => true),
    say: vi.fn(() => ({ done: Promise.resolve("played" as const), interrupt: vi.fn() })),
    interrupt: vi.fn(() => true),
    restoreHistory: vi.fn(),
    command: vi.fn(),
    onAudio: vi.fn(),
    report: vi.fn(),
    onReplyStarted: vi.fn(),
    onAudioChunk: vi.fn(),
    ...overrides,
  };
}

/**
 * A real {@link SessionEmitter} over a real stream on the memory backend — what a
 * spec passes as `createSessionCore({ emitter })`. Real, because stamping,
 * indexing and client-then-hooks ordering are the emitter's whole content.
 * Assert on the SINK for what the client saw, and on `stream` for what was
 * recorded.
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
        case "agentTranscript.updated":
        case "agentTranscript.committed":
          agentTranscripts.push(e.text);
          break;
        case "userTranscript.committed":
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
