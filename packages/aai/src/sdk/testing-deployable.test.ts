// Copyright 2026 the AAI authors. MIT license.
/**
 * The starter invariants, over defs built in place.
 *
 * What is worth asserting is the MESSAGES: every one of these replaced an
 * `expect(...)` whose failure said "expected function not to throw" or
 * "expected [] to contain 'run_code'", and the whole value of moving them into
 * the SDK is that a failure now names the invariant. The happy paths matter
 * too, because six shipped specs run these on every `aai build`.
 */

import { describe, expect, test } from "vitest";
import { agent, workflowApp } from "./define.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { expectDeployable } from "./testing-deployable.ts";
import { workflow } from "./workflow.ts";

describe("expectDeployable", () => {
  test("a def declaring nothing resolves to the default pipeline, every stage filled", () => {
    const config = expectDeployable(agent({ name: "Desk" }));
    expect(config.mode).toBe("pipeline");
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.llm?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
  });

  test("a workflow app is deployable, and says so by its mode", () => {
    const app = workflowApp({
      name: "Forms",
      workflows: { run: workflow({ description: "d", run: () => ({ ok: true }) }) },
    });
    expect(expectDeployable(app).mode).toBe("workflow-app");
  });

  test("a push-to-talk agent carries its detection through", () => {
    const config = expectDeployable(agent({ name: "Walkie", turnTaking: { detection: "manual" } }));
    expect(config.turnTaking?.detection).toBe("manual");
  });

  test("hands back the resolved config, so a spec can go on to its own claim", () => {
    const config = expectDeployable(agent({ name: "Coda", builtinTools: ["run_code"] }));
    expect(config.name).toBe("Coda");
    expect(config.builtinTools).toEqual(["run_code"]);
  });

  test("a declared stage survives and the unset ones still default", () => {
    const config = expectDeployable(
      agent({ name: "Line", llm: { kind: "anthropic", options: { model: "claude-x" } } }),
    );
    expect(config.llm).toEqual({ kind: "anthropic", options: { model: "claude-x" } });
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
  });

  test("an s2s def derives s2s mode with NO cascade beside it", () => {
    const config = expectDeployable(agent({ name: "Line", mode: "s2s", s2s: assemblyAIS2s() }));
    expect(config.mode).toBe("s2s");
    expect(config.s2s?.kind).toBe("assemblyai");
    expect(config.stt).toBeUndefined();
    expect(config.llm).toBeUndefined();
    expect(config.tts).toBeUndefined();
  });

  test("a text agent derives text mode with no audio stage — and its llm may be absent", () => {
    // `defaultProviders` skips a text agent; `createTextAgent` defaults the llm
    // at run time. So the invariant is the missing audio path, not a filled llm.
    const config = expectDeployable(agent({ name: "Chat", mode: "text" }));
    expect(config.mode).toBe("text");
    expect(config.stt).toBeUndefined();
    expect(config.tts).toBeUndefined();
  });

  test("an invalid config fails NAMING the validation invariant and the field", () => {
    // `maxSteps: 0` is the shape `toAgentConfig`'s own doc uses: a config-shape
    // mistake, answered with a sentence rather than a zod dump.
    expect(() => expectDeployable({ ...agent({ name: "Desk" }), maxSteps: 0 })).toThrow(
      /does not pass manifest validation.*maxSteps/s,
    );
  });

  test("a blank name fails as the NAMING invariant, before the conversion runs", () => {
    // `toAgentConfig` refuses this too, with "name must not be blank" — right,
    // and not the spec's claim. The message here says what the platform loses.
    expect(() => expectDeployable({ ...agent({ name: "Desk" }), name: "   " })).toThrow(
      /no name the platform can list/,
    );
  });

  test("s2s beside a pipeline stage is refused — by the conversion, named as validation", () => {
    // The type forbids `agent({ s2s, tts })` outright, so the runtime rule is
    // reached by spreading, exactly as `custom-pipeline-agent`'s spec does.
    expect(() =>
      expectDeployable({
        ...agent({ name: "Line", mode: "s2s", s2s: assemblyAIS2s() }),
        tts: { kind: "cartesia", options: {} },
      }),
    ).toThrow(/does not pass manifest validation/);
  });
});
