// Copyright 2026 the AAI authors. MIT license.
/**
 * The stray-field net under `toAgentConfig`.
 *
 * The case that motivated it is `spread`, below: an options bag merged into
 * `agent({ ...preset })` defeats excess-property checking, so TypeScript sees
 * nothing and — before this check — neither did the build.
 */
import { describe, expect, test } from "vitest";
import { type AgentConfig, toAgentConfig } from "./agent-config.ts";

/**
 * ONE narrowing, at the seam, instead of a cast per assertion.
 *
 * Every case here is by construction a config the TYPE forbids — that is the
 * point: `toAgentConfig`'s parameter cannot express a stray field, and the
 * whole finding is that the field arrives anyway (through a spread, or from a
 * raw `export default {...}` that never went through `agent()`). So the cast
 * belongs where the untyped shape enters, not at nine call sites.
 */
const configOf = (fields: Record<string, unknown>): AgentConfig =>
  toAgentConfig(fields as Parameters<typeof toAgentConfig>[0]);

describe("stray agent fields", () => {
  test("a misspelled field is rejected, and the message names the field it meant", () => {
    expect(() => configOf({ name: "A", systemPromt: "Bonjour." })).toThrow(
      /`systemPromt` \(did you mean `systemPrompt`\?\)/,
    );
  });

  test("a case slip is rejected — the likeliest typo of all, and distance 0 by letters", () => {
    expect(() => configOf({ name: "A", idleTimeoutMS: 1000 })).toThrow(
      /`idleTimeoutMS` \(did you mean `idleTimeoutMs`\?\)/,
    );
  });

  test("every stray field is named at once, not just the first", () => {
    const call = () => configOf({ name: "A", systemPromt: "x", idleTimeouts: 1, nowhereNear: 2 });
    expect(call).toThrow(/3 fields/);
    expect(call).toThrow(/systemPromt/);
    expect(call).toThrow(/idleTimeouts/);
    expect(call).toThrow(/nowhereNear/);
  });

  test("an invented field gets no suggestion — a confident wrong guess is worse than none", () => {
    expect(() => configOf({ name: "A", telemetryExporterEndpoint: "x" })).toThrow(
      /`telemetryExporterEndpoint`\. Every field/,
    );
  });

  test("the spread that started this: three typos in one options bag, all reported", () => {
    const preset = { systemPromt: "Always answer in French.", maxTurnSilenceMS: 4000 };
    expect(() => configOf({ name: "Simple Assistant", ...preset })).toThrow(
      /systemPromt.*maxTurnSilenceMS|maxTurnSilenceMS.*systemPromt/s,
    );
  });

  test("host-only fields pass — they are stripped on purpose, not strays", () => {
    expect(() =>
      configOf({
        name: "A",
        tools: {},
        events: {},
        workflows: {},
        syncState: undefined,
      }),
    ).not.toThrow();
  });

  test("the author conveniences pass — normalization consumes them before the check", () => {
    // `voice` desugars to a TTS descriptor and is gone by the time the check
    // runs. `system` used to be in this list; it is a stray now.
    const config = configOf({ name: "A", voice: "jane" });
    expect(config.tts?.kind).toBe("assemblyai");
  });

  test("a REMOVED field is named as renamed, which edit distance cannot reach", () => {
    // `system` to `systemPrompt` is six edits, past any cap a useful
    // suggestion can afford — and it is the mistake most worth catching,
    // because the author did not typo anything: they wrote a field that
    // used to work.
    expect(() => configOf({ name: "A", system: "Be brief." })).toThrow(
      /`system` \(renamed to `systemPrompt`\)/,
    );
  });

  test("endpointing shorthand passes — `takeNumber` deletes it before the check sees it", () => {
    expect(() => configOf({ name: "A", maxTurnSilenceMs: 4000 })).not.toThrow();
  });

  test("a well-formed agent is untouched", () => {
    const config = configOf({ name: "A", systemPrompt: "Be brief.", maxSteps: 4 });
    expect(config.maxSteps).toBe(4);
  });
});
