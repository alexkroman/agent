// Copyright 2026 the AAI authors. MIT license.
// `agent({ systemPrompt })` takes a string OR a per-request resolver, and the
// two narrowings here are the ONE place that union is split. They matter
// because getting the split wrong is silent in the worst way: a config layer
// that read `systemPrompt` as a string without `staticSystemPrompt` would hand
// `buildSystemPrompt` a function, and the resolver's SOURCE TEXT would go into
// the model's instructions — which neither the AI SDK nor OpenAI Realtime
// rejects.

import { describe, expect, test } from "vitest";
import type { AgentInstructions, AgentSystemPrompt } from "./agent-instructions.ts";
import { staticSystemPrompt, systemPromptResolver } from "./agent-instructions.ts";
import type { AgentSessionContext } from "./agent-session-context.ts";
import { createDetachedSlotStore } from "./session-state.ts";

const CTX: AgentSessionContext = {
  sessionId: "s-1",
  env: { TIER: "gold" },
  slots: createDetachedSlotStore(),
};

const resolver: AgentInstructions = (ctx) => `Session ${ctx.sessionId}, tier ${ctx.env.TIER}.`;

describe("the two halves are EXCLUSIVE — exactly one answers for any prompt", () => {
  test("a plain string is static and has no resolver", () => {
    const prompt: AgentSystemPrompt = "Be brief.";
    expect(staticSystemPrompt(prompt)).toBe("Be brief.");
    expect(systemPromptResolver(prompt)).toBeUndefined();
  });

  test("a resolver is a resolver and has no static text", () => {
    // The failure this prevents: a caller reading `systemPrompt` as a string
    // gets `undefined` here rather than a function it would stringify into the
    // model's instructions.
    expect(staticSystemPrompt(resolver)).toBeUndefined();
    expect(systemPromptResolver(resolver)).toBe(resolver);
  });

  test("an absent prompt is neither", () => {
    // Most agents set none at all, and the framework's own prompt is the whole
    // instruction. Both narrowings must answer `undefined` rather than throw.
    expect(staticSystemPrompt(undefined)).toBeUndefined();
    expect(systemPromptResolver(undefined)).toBeUndefined();
  });

  test("an EMPTY string is static, not absent", () => {
    // `""` is a value an author wrote, and `typeof === "string"` is the test
    // rather than truthiness: a falsy check here would silently promote an
    // empty override to "no override".
    expect(staticSystemPrompt("")).toBe("");
    expect(systemPromptResolver("")).toBeUndefined();
  });

  test("a raw config's junk value is neither, though the TYPE cannot say so", () => {
    // The narrowings take `AgentSystemPrompt | undefined`, so every in-repo
    // caller is checked — but they still run at the config boundary, which a
    // hand-written `export default {...}` also crosses, and there a number or
    // an object must fall out rather than reach `buildSystemPrompt`. The cast
    // is the point of the case: it stages what only an unchecked caller can
    // send.
    const junk: unknown[] = [42, null, {}, [], true];
    for (const value of junk) {
      const raw = value as AgentSystemPrompt;
      expect(staticSystemPrompt(raw)).toBeUndefined();
      expect(systemPromptResolver(raw)).toBeUndefined();
    }
  });
});

describe("the resolver it hands back is the author's own function", () => {
  test("it is returned unwrapped, so the call is the author's call", () => {
    // Not merely equivalent: the runtime calls this once per model request, and
    // a wrapper would put a frame on the per-turn path and break identity
    // comparisons the transports use to tell a resolver from a re-resolve.
    const found = systemPromptResolver(resolver);
    expect(found).toBe(resolver);
    expect(found?.(CTX)).toBe("Session s-1, tier gold.");
  });

  test("it is handed the SESSION, which is the whole reason it takes an argument", () => {
    // A nullary resolver could vary the prompt by wall-clock time and nothing
    // else. Reading a slot is what lets it say "this caller is authenticated".
    const seen: AgentSessionContext[] = [];
    const recording: AgentInstructions = (ctx) => {
      seen.push(ctx);
      return "ok";
    };
    systemPromptResolver(recording)?.(CTX);
    expect(seen).toEqual([CTX]);
    expect(seen[0]?.slots).toBe(CTX.slots);
  });
});
