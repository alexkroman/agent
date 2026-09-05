// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers for the `host/` modules that stayed in this package.
 *
 * The bulk of the old `host/_test-utils.ts` went to `@alexkroman1/aai-runtime`
 * with the code it exercises. These four are what the modules serving
 * `@alexkroman1/aai/tools`, `/ffmpeg`, `/slugify` and `/workspace-files` still
 * need, plus two `sdk/` specs. They are duplicated rather than imported across
 * the package boundary deliberately: a test helper is not published, and a
 * published package must not depend on another package's test surface.
 */

import type { ToolContext } from "@alexkroman1/aai";
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows } from "@alexkroman1/aai/internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { vi } from "vitest";

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

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    slots: createDetachedSlotStore(),
    // The SDK's own published helper rather than `{} as never`: it REJECTS
    // naming itself, so a spec that unexpectedly reaches `ctx.db` says so
    // instead of dying on a TypeError against an empty object. `as never` is
    // assignable to every position and stops reporting when `Db` grows a
    // method — the laundering idiom the escape-hatch ratchet now counts.
    generate: () => Promise.reject(new Error("generate not mocked")),
    delegate: () => Promise.reject(new Error("delegate not mocked")),
    messages: [],
    sessionId: "test-session",
    send: vi.fn(),
    // Rejects rather than no-ops: a spec that reaches `ctx.workflows` without
    // stubbing one is asserting against a fake, and the message says so.
    workflows: rejectingWorkflows("ctx.workflows not mocked"),
    // A signal that never aborts — `ToolContext.signal` is non-optional, and
    // "this context cannot cancel" is spelled as a live-forever signal rather
    // than as an absent field.
    signal: new AbortController().signal,
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

/**
 * Narrow a test double to `fetch`'s type, in ONE place.
 *
 * A fake fetch never matches `typeof globalThis.fetch` structurally — the real
 * signature takes `RequestInfo | URL`, returns a full `Response`, and carries
 * `preconnect` — so every call site was laundering its double through a
 * double-cast to get there. That is the concentration of identical casts the
 * root guide names as a missing typed seam: 27 of them across four suites
 * here. The narrowing happens once, below, and the call sites read as what
 * they are.
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}
