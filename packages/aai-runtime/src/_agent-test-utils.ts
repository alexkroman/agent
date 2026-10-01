// Copyright 2025 the AAI authors. MIT license.

/**
 * Agent-side factories: tools, agent defs, configs, tool and session contexts,
 * speech and the usage meter.
 */

import type {
  AgentDef,
  AgentSessionContext,
  SessionSpeech,
  ToolContext,
  ToolDef,
  ToolErrorHandler,
} from "@alexkroman1/aai";
import { createSeededRandom, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { createDetachedSlotStore, DETACHED_SESSION_SPEECH } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai/internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { vi } from "vitest";
import { createUsageMeter, type UsageMeter, type UsageSnapshot } from "./usage-meter.ts";

export function createMockToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {},
    slots: createDetachedSlotStore(),
    speech: DETACHED_SESSION_SPEECH,
    // Unmocked capabilities REJECT, naming themselves, rather than `{} as never`.
    generate: () => Promise.reject(new Error("generate not mocked")),
    delegate: () => Promise.reject(new Error("delegate not mocked")),
    deadlineAt: Date.now() + TOOL_EXECUTION_TIMEOUT_MS,
    // Seeded, so a spec that never mentions randomness stays deterministic.
    random: createSeededRandom(20_260_101),
    messages: [],
    sessionId: "test-session",
    send: vi.fn(),
    workflows: rejectingWorkflows("ctx.workflows not mocked"),
    // `signal` is non-optional: "cannot cancel" is a signal that never aborts.
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return { description: "test tool", execute: () => "ok", ...overrides };
}

/**
 * An `onError` the TYPE forbids — one returning nothing, or a promise — for
 * the `resolveToolError` guards that refuse them. One widening here rather than
 * a cast per spec.
 */
export function malformedOnError(handler: (err: unknown, ctx: never) => unknown): ToolErrorHandler {
  // A CHECKED narrowing: `ToolErrorHandler` is assignable to the parameter, so
  // only the return type is being asserted.
  return handler as ToolErrorHandler;
}

export function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  // S2S (mode plus descriptor) unless the caller declares providers or a mode:
  // most suites drive the S2S transport through a mocked WebSocket.
  const declaresProviders =
    overrides != null &&
    (overrides.stt != null ||
      overrides.llm != null ||
      overrides.tts != null ||
      overrides.s2s != null ||
      overrides.mode !== undefined);
  const base: AgentDef = {
    name: "test-agent",
    systemPrompt: "Be helpful.",
    greeting: "Hello!",
    maxSteps: 5,
    tools: {},
  };
  if (!declaresProviders) Object.assign(base, { mode: "s2s", s2s: assemblyAIS2s() });
  return { ...base, ...overrides };
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
 * A {@link UsageMeter} plus the snapshots it announced — the pair is the
 * observable surface, since `snapshot()` alone cannot say a step was announced.
 */
export function makeUsageMeter(limits?: { totalTokens?: number } | undefined): {
  meter: UsageMeter;
  updates: UsageSnapshot[];
} {
  const updates: UsageSnapshot[] = [];
  const meter = createUsageMeter({ limits, onUpdate: (snapshot) => void updates.push(snapshot) });
  return { meter, updates };
}

/** A {@link SessionSpeech} that records what it was asked to say. */
export function makeSpeech(): SessionSpeech & { said: string[]; interrupts: number } {
  const speech = {
    said: [] as string[],
    interrupts: 0,
    say(text: string) {
      speech.said.push(text);
      return { done: Promise.resolve("played" as const), interrupt: () => undefined };
    },
    interrupt() {
      speech.interrupts += 1;
      return true;
    },
  };
  return speech;
}

/**
 * What a per-session author FUNCTION is handed — a `systemPrompt` resolver, a
 * guardrail, a dialog's instruction. Its slot store is DETACHED (backed by
 * nothing), so two specs holding one cannot see each other's writes.
 */
export function makeSessionContext(
  overrides: Partial<AgentSessionContext> = {},
): AgentSessionContext {
  return { sessionId: "s-1", env: {}, slots: createDetachedSlotStore(), ...overrides };
}
