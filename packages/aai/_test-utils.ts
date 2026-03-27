// Copyright 2025 the AAI authors. MIT license.

import type { AgentConfig } from "./_internal-types.ts";
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
    vector: {} as never,
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
