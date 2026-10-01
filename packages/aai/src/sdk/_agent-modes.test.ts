// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { assertModeFields, resolveAgentMode } from "./_agent-modes.ts";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { toAgentConfig } from "./agent-config.ts";
import { agent, workflowApp } from "./define.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { workflow } from "./workflow.ts";

/** A raw, untyped declaration — the caller no excess-property check sees. */
const raw = (fields: Record<string, unknown>) =>
  toAgentConfig({ name: "raw", ...fields } as Parameters<typeof toAgentConfig>[0]);
/** The same through `agent()`, past the overloads on purpose. */
const untyped = (fields: Record<string, unknown>) =>
  agent({ name: "untyped", ...fields } as Parameters<typeof agent>[0]);

const workflows = {
  run: workflow({ description: "d", run: () => ({ ok: true }) }),
};

describe("resolveAgentMode", () => {
  test("absent is pipeline; a declared mode is itself", () => {
    expect(resolveAgentMode({})).toBe("pipeline");
    expect(resolveAgentMode({ mode: "s2s", s2s: assemblyAIS2s() })).toBe("s2s");
    expect(resolveAgentMode({ mode: "text" })).toBe("text");
    expect(resolveAgentMode({ mode: "workflow-app" })).toBe("workflow-app");
  });

  test.each([
    [{ mode: "voice" }, /`mode` must be one of/],
    [{ mode: "s2s" }, /needs the `s2s` descriptor it selects/],
  ])("refuses %j", (fields, message) => {
    expect(() => resolveAgentMode(fields)).toThrow(message);
  });
});

describe("assertModeFields", () => {
  test("a pipeline agent may carry everything a pipeline has, and no s2s descriptor", () => {
    expect(() =>
      assertModeFields("pipeline", {
        silence: { deadAirCoverMs: 1 },
        temperature: 0.1,
      }),
    ).not.toThrow();
    // An `s2s` descriptor with no `mode` is a PIPELINE agent carrying one — the
    // spelling `mode` replaced, refused rather than silently promoted to S2S.
    expect(() => assertModeFields("pipeline", { s2s: assemblyAIS2s() })).toThrow(
      /`s2s` is the speech-to-speech descriptor — it has no effect on a "pipeline" agent.*declare `mode: "s2s"`/,
    );
  });

  test.each([
    "stt",
    "tts",
    "llm",
    "turnTaking",
    "interruption",
    "silence",
    "errorPhrase",
    "startFailurePhrase",
  ])("an s2s agent refuses %s, naming the field and the mode", (field) => {
    expect(() => assertModeFields("s2s", { [field]: 1 })).toThrow(
      new RegExp(`^\`${field}\` is .* no effect on a "s2s" agent`),
    );
  });

  test.each(["stt", "tts", "s2s", "sttPrompt", "telephony", "turnTaking"])(
    "a text agent refuses %s",
    (field) => {
      expect(() => assertModeFields("text", { [field]: 1 })).toThrow(
        new RegExp(`^\`${field}\` .* no effect on a "text" agent`),
      );
    },
  );

  test.each([
    "silence",
    "voicePresets",
    "toolChoice",
    "builtinTools",
    "syncState",
    "events",
    "telephony",
    "idleTimeoutMs",
    "temperature",
    "outputGuardrails",
    "s2s",
  ])("a workflow app refuses %s", (field) => {
    expect(() => assertModeFields("workflow-app", { [field]: 1 })).toThrow(
      new RegExp(`^\`${field}\` .* no effect on a "workflow-app" agent`),
    );
  });

  test("the fields the framework fills stay type-level only for a workflow app", () => {
    // `agent()` fills `systemPrompt` and `maxSteps`, and the default fill the
    // three stages, on every definition — so the config boundary sees them on a
    // workflow app it built itself, and on a runtime's effective providers.
    const filled = { systemPrompt: "p", maxSteps: 3, stt: {}, llm: {}, tts: {} };
    expect(() => assertModeFields("workflow-app", filled)).not.toThrow();
  });
});

describe("agent() and toAgentConfig carry the mode", () => {
  test("agent() writes `mode` on every definition, the default included", () => {
    expect(agent({ name: "p" }).mode).toBe("pipeline");
    expect(agent({ name: "s", mode: "s2s", s2s: assemblyAIS2s() }).mode).toBe("s2s");
    expect(agent({ name: "t", mode: "text" }).mode).toBe("text");
    expect(workflowApp({ name: "a", workflows }).mode).toBe("workflow-app");
  });

  test("the wire carries the AUTHORED mode, a workflow app's included", () => {
    expect(toAgentConfig(agent({ name: "p" })).mode).toBe("pipeline");
    expect(toAgentConfig(workflowApp({ name: "a", workflows })).mode).toBe("workflow-app");
    expect(raw({ mode: "text" }).mode).toBe("text");
  });

  test("the normalization is idempotent, because toAgentConfig re-runs it over agent()'s output", () => {
    for (const fields of [
      { name: "t", mode: "text", temperature: 0.2 },
      { name: "s", mode: "s2s", s2s: assemblyAIS2s() },
      { name: "a", mode: "workflow-app", workflows },
      { name: "p", turnTaking: { maxSilenceMs: 4000, detection: "manual" } },
    ]) {
      const once = normalizeAgentParams(fields);
      expect(normalizeAgentParams(once)).toEqual(once);
    }
  });

  test("an untyped caller meets the same refusals as the type", () => {
    expect(() =>
      untyped({ mode: "s2s", s2s: assemblyAIS2s(), interruption: { minWords: 1 } }),
    ).toThrow(/`interruption` .* "s2s" agent/);
    expect(() => raw({ mode: "text", tts: { kind: "assemblyai", options: {} } })).toThrow(
      /`tts` .* "text" agent/,
    );
    expect(() => untyped({ mode: "workflow-app", workflows, syncState: () => 0 })).toThrow(
      /`syncState` .* "workflow-app" agent/,
    );
  });

  test("the flags `mode` replaced are refused by name, with the field to write instead", () => {
    expect(() => untyped({ text: true })).toThrow(/`text` \(renamed to `mode: "text"`\)/);
    expect(() => untyped({ page: "static", workflows })).toThrow(
      /`page` \(renamed to `mode: "workflow-app"`\)/,
    );
  });
});
