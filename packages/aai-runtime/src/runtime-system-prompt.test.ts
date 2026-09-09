// Copyright 2026 the AAI authors. MIT license.
// Specs for the two halves of a session's system prompt: the base cached per
// calendar day, and the per-turn suffix the `dialog()` integration will install.

import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeSessionContext } from "./_test-utils.ts";
import { createSystemPromptResolver } from "./runtime-system-prompt.ts";

const TEST_SESSION_CONTEXT = makeSessionContext();

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
    expect(prompts.forSession(TEST_SESSION_CONTEXT).resolve()).toBe(prompts.base());
  });

  test("an installed suffix is appended below the base, as one more section", () => {
    const prompts = resolverFor();
    const session = prompts.forSession(TEST_SESSION_CONTEXT);
    session.setSuffix(() => "Phase: collecting the shipping address.");
    expect(session.resolve()).toBe(`${prompts.base()}\n\nPhase: collecting the shipping address.`);
  });

  test("a suffix that answers empty costs nothing — no separator, no change", () => {
    // A phase machine sitting in a state with nothing to say must not move the
    // prompt by two characters, or every such agent's prompt differs from the
    // one an agent without a dialog sends.
    const prompts = resolverFor();
    const session = prompts.forSession(TEST_SESSION_CONTEXT);
    session.setSuffix(() => "");
    expect(session.resolve()).toBe(prompts.base());
  });

  test("the suffix is asked EVERY time, not captured at install", () => {
    // The whole point: a turn on which no tool ran still sees where the call
    // has got to. A captured value would be the frozen string this replaced.
    const prompts = resolverFor();
    const session = prompts.forSession(TEST_SESSION_CONTEXT);
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
    const a = prompts.forSession(TEST_SESSION_CONTEXT);
    const b = prompts.forSession(TEST_SESSION_CONTEXT);
    a.setSuffix(() => "Phase: refund.");
    expect(a.resolve()).toContain("Phase: refund.");
    expect(b.resolve()).toBe(prompts.base());
  });

  test("both sessions share the cached base", () => {
    const prompts = resolverFor();
    const a = prompts.forSession(TEST_SESSION_CONTEXT);
    const b = prompts.forSession(TEST_SESSION_CONTEXT);
    expect(a.resolve()).toBe(b.resolve());
  });

  test("the agent's own instructions survive into every resolution", () => {
    const prompts = resolverFor("Always confirm the order number.");
    const session = prompts.forSession(TEST_SESSION_CONTEXT);
    session.setSuffix(() => "Phase: intake.");
    expect(session.resolve()).toContain("Always confirm the order number.");
    expect(session.resolve()).toContain("Phase: intake.");
  });
});

describe("a systemPrompt RESOLVER", () => {
  /** A resolver's answer lands under the same header a static prompt's does. */
  const INSTRUCTIONS_HEADER = "Agent-specific instructions";

  function withResolver(
    instructions: (ctx: typeof TEST_SESSION_CONTEXT) => string,
  ): ReturnType<typeof createSystemPromptResolver> {
    return createSystemPromptResolver({
      // Exactly what `toAgentConfig` produces for a resolver: no
      // agent-specific section on the wire, because a function cannot cross it.
      agentConfig: toAgentConfig({ name: "Desk", greeting: "" }),
      hasTools: false,
      toolGuidance: undefined,
      instructions,
    });
  }

  test("its answer is appended under the precedence header, not in place of the prompt", () => {
    // The rule an author has to be able to rely on: a resolver does not replace
    // the framework's voice sections any more than a string does.
    const session = withResolver(() => "The caller is verified.").forSession(TEST_SESSION_CONTEXT);
    const resolved = session.resolve();
    expect(resolved).toContain(INSTRUCTIONS_HEADER);
    expect(resolved).toContain("The caller is verified.");
    expect(resolved.indexOf("The caller is verified.")).toBeGreaterThan(
      resolved.indexOf(INSTRUCTIONS_HEADER),
    );
  });

  test("it is re-asked on every resolve, and sees the session it was given", () => {
    // The reason the resolver takes a context at all: a nullary thunk can vary
    // by wall clock and by nothing else, so it could not read a slot.
    const seen: string[] = [];
    let phase = "greeting";
    const session = withResolver((ctx) => {
      seen.push(ctx.sessionId);
      return `phase: ${phase}`;
    }).forSession(TEST_SESSION_CONTEXT);

    expect(session.resolve()).toContain("phase: greeting");
    phase = "payment";
    expect(session.resolve()).toContain("phase: payment");
    expect(seen).toEqual(["s-1", "s-1"]);
  });

  test("an empty answer changes the prompt by not one byte", () => {
    const prompts = withResolver(() => "");
    expect(prompts.forSession(TEST_SESSION_CONTEXT).resolve()).toBe(prompts.base());
  });

  test("a dialog suffix composes with it rather than replacing it", () => {
    // A session may legitimately have both, which is why the resolver is NOT
    // installed through `setSuffix` — that slot is the dialogs', last writer
    // wins.
    const session = withResolver(() => "Instructions.").forSession(TEST_SESSION_CONTEXT);
    session.setSuffix(() => "Current phase: checkout.");
    const resolved = session.resolve();
    expect(resolved).toContain("Instructions.");
    expect(resolved).toContain("Current phase: checkout.");
    expect(resolved.indexOf("Instructions.")).toBeLessThan(
      resolved.indexOf("Current phase: checkout."),
    );
  });
});
