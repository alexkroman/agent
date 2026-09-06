// Copyright 2026 the AAI authors. MIT license.
// Specs for the two halves of a session's system prompt: the base cached per
// calendar day, and the per-turn suffix the `dialog()` integration will install.

import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSystemPromptResolver } from "./runtime-system-prompt.ts";

function resolverFor(systemPrompt = "Be brief."): ReturnType<typeof createSystemPromptResolver> {
  return createSystemPromptResolver({
    agentConfig: toAgentConfig({ name: "Desk", greeting: "", systemPrompt }),
    hasTools: false,
    toolGuidance: undefined,
  });
}

describe("the base is cached per calendar day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the same day answers the same string identity — the date stamp is paid once", () => {
    vi.setSystemTime(new Date("2026-03-14T09:00:00Z"));
    const prompts = resolverFor();
    const first = prompts.base();
    vi.setSystemTime(new Date("2026-03-14T21:30:00Z"));
    // Identity, not equality: an equal string would also pass if the cache were
    // gone, and the cache is the whole reason `buildSystemPrompt` is not on the
    // session-start path.
    expect(prompts.base()).toBe(first);
  });

  test("a replica that lives across midnight stops serving yesterday's date", () => {
    vi.setSystemTime(new Date("2026-03-14T23:59:00Z"));
    const prompts = resolverFor();
    expect(prompts.base()).toContain("March 14, 2026");
    vi.setSystemTime(new Date("2026-03-15T00:01:00Z"));
    expect(prompts.base()).toContain("March 15, 2026");
  });
});

describe("a session's prompt", () => {
  test("with no suffix installed it IS the base, byte for byte", () => {
    // The property that makes this seam safe to land before anything consumes
    // it: every agent that ships today sends exactly what it sent before.
    const prompts = resolverFor();
    expect(prompts.forSession().resolve()).toBe(prompts.base());
  });

  test("an installed suffix is appended below the base, as one more section", () => {
    const prompts = resolverFor();
    const session = prompts.forSession();
    session.setSuffix(() => "Phase: collecting the shipping address.");
    expect(session.resolve()).toBe(`${prompts.base()}\n\nPhase: collecting the shipping address.`);
  });

  test("a suffix that answers empty costs nothing — no separator, no change", () => {
    // A phase machine sitting in a state with nothing to say must not move the
    // prompt by two characters, or every such agent's prompt differs from the
    // one an agent without a dialog sends.
    const prompts = resolverFor();
    const session = prompts.forSession();
    session.setSuffix(() => "");
    expect(session.resolve()).toBe(prompts.base());
  });

  test("the suffix is asked EVERY time, not captured at install", () => {
    // The whole point: a turn on which no tool ran still sees where the call
    // has got to. A captured value would be the frozen string this replaced.
    const prompts = resolverFor();
    const session = prompts.forSession();
    let phase = "greeting";
    session.setSuffix(() => `Phase: ${phase}.`);
    expect(session.resolve()).toContain("Phase: greeting.");
    phase = "wrap-up";
    expect(session.resolve()).toContain("Phase: wrap-up.");
  });

  test("two sessions do not see each other's suffix", () => {
    // The suffix belongs to one CALL. Hoisted to runtime scope it would be one
    // caller's dialog phase leaking into every concurrent call — invisible on a
    // machine serving one session at a time, which is every developer's.
    const prompts = resolverFor();
    const a = prompts.forSession();
    const b = prompts.forSession();
    a.setSuffix(() => "Phase: refund.");
    expect(a.resolve()).toContain("Phase: refund.");
    expect(b.resolve()).toBe(prompts.base());
  });

  test("both sessions share the cached base", () => {
    const prompts = resolverFor();
    const a = prompts.forSession();
    const b = prompts.forSession();
    expect(a.resolve()).toBe(b.resolve());
  });

  test("the agent's own instructions survive into every resolution", () => {
    const prompts = resolverFor("Always confirm the order number.");
    const session = prompts.forSession();
    session.setSuffix(() => "Phase: intake.");
    expect(session.resolve()).toContain("Always confirm the order number.");
    expect(session.resolve()).toContain("Phase: intake.");
  });
});
