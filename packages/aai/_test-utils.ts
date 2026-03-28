// Copyright 2025 the AAI authors. MIT license.

import { createNanoEvents } from "nanoevents";
import { vi } from "vitest";
import type { AgentConfig } from "./_internal-types.ts";
import type { ClientSink } from "./protocol.ts";
import type { S2sEvents, S2sHandle } from "./s2s.ts";
import type { S2sSessionOptions } from "./session.ts";
import type { AgentDef, ToolContext, ToolDef } from "./types.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

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
    sendUpdate() {
      // no-op in tests
    },
    fetch: globalThis.fetch,
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
    instructions: "Be helpful.",
    greeting: "Hello!",
    maxSteps: 5,
    tools: {},
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    instructions: DEFAULT_INSTRUCTIONS,
    greeting: "Hello",
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
      instructions: DEFAULT_INSTRUCTIONS,
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
