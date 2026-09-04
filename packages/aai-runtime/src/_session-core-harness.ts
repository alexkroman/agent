// Copyright 2026 the AAI authors. MIT license.
/**
 * The `ServerSession` test harness — one sink, one transport, one core.
 *
 * Its own module because TWO suites need it (`session-core.test.ts` and
 * `session-core-history.test.ts`, split when the first crossed the 700-line test
 * cap) and `host/_test-utils.ts` sits at 493 of its own 500-line SOURCE cap, with
 * no room for sixty more. The alternative — a second copy beside the second suite
 * — is the shape this package's own testing notes call out: a harness written
 * twice is a harness that drifts, and here it stands in for the session's whole
 * inbound surface.
 */

import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { vi } from "vitest";
import { makeEmitter } from "./_test-utils.ts";
import type { ServerSession, ServerSessionOptions } from "./session-core.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import type { Transport } from "./transports/types.ts";

// `playAudioDone` / `start` / `stop` are plain `vi.fn()`s like every other
// member here: a spy already records its own call count, so the hand-rolled
// `let audioDoneCount = 0` + getter + `readonly` field triple (and the same
// for starts/stops) was 18 lines of bookkeeping duplicating `mock.calls`.
export function makeSink(): {
  events: SessionEvent[];
  audioChunks: Uint8Array[];
  closeReasons: (string | undefined)[];
  sink: ClientSink;
} {
  const events: SessionEvent[] = [];
  const audioChunks: Uint8Array[] = [];
  const closeReasons: (string | undefined)[] = [];
  return {
    events,
    audioChunks,
    closeReasons,
    sink: {
      open: true,
      event: (e) => {
        events.push(e);
      },
      playAudioChunk: (chunk) => {
        audioChunks.push(chunk);
      },
      close: (reason) => {
        closeReasons.push(reason);
      },
    },
  };
}

export function makeTransport(): Transport {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "test", systemPrompt: DEFAULT_SYSTEM_PROMPT, greeting: "", ...overrides };
}

export function makeCore(overrides: Partial<ServerSessionOptions> = {}): {
  core: ServerSession;
  sink: ReturnType<typeof makeSink>;
  transport: ReturnType<typeof makeTransport>;
  stream: SessionEventStream;
} {
  const sink = makeSink();
  const transport = makeTransport();
  // Over the client a spec actually passed, not `sink.sink` — an override that
  // wraps the sink (the idle-ordering spec below) has to see the events.
  const client = overrides.client ?? sink.sink;
  // A real emitter over a real stream — see `makeEmitter`'s doc for why the seam
  // is not stubbed. `stream` comes back so a spec can assert on what was
  // RECORDED, which is a different question from what the sink saw.
  const { emitter, stream } = makeEmitter(client, { sessionId: "s-test" });
  const core = createSessionCore({
    id: "s-test",
    agent: "test-agent",
    client,
    emitter,
    agentConfig: makeAgentConfig(),
    executeTool: vi.fn(async () => "ok"),
    transport,
    ...overrides,
  });
  return { core, sink, transport, stream };
}
