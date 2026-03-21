// Copyright 2025 the AAI authors. MIT license.

import type { ToolContext } from "./types.ts";

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    state: {},
    kv: {} as never,
    vector: {} as never,
    messages: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}
