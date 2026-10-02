// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers for this package's specs. A tool context is the published
 * `createToolContext` from `@alexkroman1/aai/testing`.
 */

import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { onTestFinished, vi } from "vitest";

/**
 * Yield a full MACROTASK — drains microtasks and also lets already-scheduled
 * zero-delay timers and I/O callbacks run. It uses the GLOBAL `setTimeout`, so
 * fake timers drive it (`node:timers/promises` is refused by guard-invariants
 * rule 19).
 */
export function tick(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: "Hello",
    ...overrides,
  };
}

/**
 * Narrow a test double to `fetch`'s type, in ONE place: a fake never matches
 * `typeof globalThis.fetch` structurally (`RequestInfo | URL`, a full
 * `Response`, `preconnect`).
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

/**
 * Fake `Date` (and nothing else) for the rest of this test, frozen at `at`, so
 * a wall-clock assertion can be exact. Timers stay real.
 */
export function freezeDate(at = 1_800_000_000_000): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return at;
}
