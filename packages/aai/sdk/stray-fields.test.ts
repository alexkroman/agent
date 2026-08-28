// Copyright 2026 the AAI authors. MIT license.
/**
 * The stray-field net under `toAgentConfig`.
 *
 * The case that motivated it is `spread`, below: an options bag merged into
 * `agent({ ...preset })` defeats excess-property checking, so TypeScript sees
 * nothing and — before this check — neither did the build.
 */
import { describe, expect, test } from "vitest";
import { toAgentConfig } from "./agent-config.ts";

describe("stray agent fields", () => {
  test("a misspelled field is rejected, and the message names the field it meant", () => {
    expect(() => toAgentConfig({ name: "A", systemPromt: "Bonjour." } as never)).toThrow(
      /`systemPromt` \(did you mean `systemPrompt`\?\)/,
    );
  });

  test("a case slip is rejected — the likeliest typo of all, and distance 0 by letters", () => {
    expect(() => toAgentConfig({ name: "A", idleTimeoutMS: 1000 } as never)).toThrow(
      /`idleTimeoutMS` \(did you mean `idleTimeoutMs`\?\)/,
    );
  });

  test("every stray field is named at once, not just the first", () => {
    const call = () =>
      toAgentConfig({ name: "A", systemPromt: "x", idleTimeouts: 1, nowhereNear: 2 } as never);
    expect(call).toThrow(/3 fields/);
    expect(call).toThrow(/systemPromt/);
    expect(call).toThrow(/idleTimeouts/);
    expect(call).toThrow(/nowhereNear/);
  });

  test("an invented field gets no suggestion — a confident wrong guess is worse than none", () => {
    expect(() => toAgentConfig({ name: "A", telemetryExporterEndpoint: "x" } as never)).toThrow(
      /`telemetryExporterEndpoint`\. Every field/,
    );
  });

  test("the spread that started this: three typos in one options bag, all reported", () => {
    const preset = { systemPromt: "Always answer in French.", maxTurnSilenceMS: 4000 };
    expect(() => toAgentConfig({ name: "Simple Assistant", ...preset } as never)).toThrow(
      /systemPromt.*maxTurnSilenceMS|maxTurnSilenceMS.*systemPromt/s,
    );
  });

  test("host-only fields pass — they are stripped on purpose, not strays", () => {
    expect(() =>
      toAgentConfig({
        name: "A",
        tools: {},
        events: {},
        workflows: {},
        syncState: undefined,
      } as never),
    ).not.toThrow();
  });

  test("the author conveniences pass — normalization consumes them before the check", () => {
    const config = toAgentConfig({ name: "A", system: "Be brief.", voice: "jane" } as never);
    expect(config.systemPrompt).toBe("Be brief.");
  });

  test("endpointing shorthand passes — `takeNumber` deletes it before the check sees it", () => {
    expect(() => toAgentConfig({ name: "A", maxTurnSilenceMs: 4000 } as never)).not.toThrow();
  });

  test("a well-formed agent is untouched", () => {
    const config = toAgentConfig({ name: "A", systemPrompt: "Be brief.", maxSteps: 4 } as never);
    expect(config.maxSteps).toBe(4);
  });
});
