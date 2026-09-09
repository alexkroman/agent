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
import { agent } from "./define.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import {
  commandedBuiltins,
  expectDeployable,
  expectPromptBuiltinsDeclared,
} from "./testing-deployable.ts";

describe("expectDeployable", () => {
  test("a def declaring nothing resolves to the default pipeline, every stage filled", () => {
    const config = expectDeployable(agent({ name: "Desk" }));
    expect(config.mode).toBe("pipeline");
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.llm?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
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
    const config = expectDeployable(agent({ name: "Line", s2s: assemblyAIS2s() }));
    expect(config.mode).toBe("s2s");
    expect(config.s2s?.kind).toBe("assemblyai");
    expect(config.stt).toBeUndefined();
    expect(config.llm).toBeUndefined();
    expect(config.tts).toBeUndefined();
  });

  test("a text agent derives text mode with no audio stage — and its llm may be absent", () => {
    // `defaultProviders` skips a text agent; `createTextAgent` defaults the llm
    // at run time. So the invariant is the missing audio path, not a filled llm.
    const config = expectDeployable(agent({ name: "Chat", text: true }));
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
        ...agent({ name: "Line", s2s: assemblyAIS2s() }),
        tts: { kind: "cartesia", options: {} },
      }),
    ).toThrow(/does not pass manifest validation/);
  });
});

describe("commandedBuiltins", () => {
  test("finds the builtins the prompt names and skips the prompt's own snake_case", () => {
    const config = expectDeployable(
      agent({
        name: "Penny",
        systemPrompt:
          "Use fetch_json for anything that moves (vs_currencies, include_24hr_change). " +
          "Work every figure out with run_code — per_person, annual_rate — never in your head. " +
          "fetch_json again for crypto.",
      }),
    );
    // First-mention order, deduplicated, and nothing that is not a builtin.
    expect(commandedBuiltins(config)).toEqual(["fetch_json", "run_code"]);
  });

  test("a prompt naming no builtin answers an empty list", () => {
    expect(commandedBuiltins(expectDeployable(agent({ name: "Desk" })))).toEqual([]);
  });
});

describe("expectPromptBuiltinsDeclared", () => {
  test("passes when every commanded builtin is declared, and answers the list", () => {
    expect(
      expectPromptBuiltinsDeclared(
        agent({
          name: "Penny",
          systemPrompt: "Rates via fetch_json; arithmetic via run_code.",
          builtinTools: ["run_code", "fetch_json", "web_search"],
        }),
      ),
    ).toEqual(["fetch_json", "run_code"]);
  });

  test("a commanded builtin nothing declares fails naming it and what IS declared", () => {
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({
          name: "Penny",
          systemPrompt: "Rates via fetch_json; arithmetic via run_code.",
          builtinTools: ["run_code"],
        }),
      ),
    ).toThrow(/commands "fetch_json" and `builtinTools` declares run_code/);
  });

  test("declaring none reads as 'none', not as an empty join", () => {
    expect(() =>
      expectPromptBuiltinsDeclared(agent({ name: "Coda", systemPrompt: "Call run_code." })),
    ).toThrow(/declares none/);
  });

  test("a prompt commanding no builtin FAILS, pointing at the unapplied-prompt cause", () => {
    // The state a template is in when `system-prompt.md` did not reach the
    // config: the framework default names no builtin.
    expect(() => expectPromptBuiltinsDeclared(agent({ name: "Desk" }))).toThrow(
      /commands no builtin at all.*virtual:aai\/agent/s,
    );
  });

  test("a `systemPrompt` RESOLVER is called, and its own prompt is what gets scanned", () => {
    // The trap this closes: `toAgentConfig` cannot serialize a function, so it
    // drops the field and the schema fills in the framework default — and the
    // scan then reports on a prompt this agent never sends. It named no builtin,
    // so the check failed for the wrong reason today and would have PASSED the
    // day the default prompt happened to name one.
    expect(
      expectPromptBuiltinsDeclared(
        agent({
          name: "Cavern",
          systemPrompt: () => "Roll every check with run_code. Look prices up with fetch_json.",
          builtinTools: ["run_code", "fetch_json"],
        }),
      ),
    ).toEqual(["run_code", "fetch_json"]);
  });

  test("a resolver's undeclared builtin fails naming IT, not the unapplied-prompt cause", () => {
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({
          name: "Cavern",
          systemPrompt: () => "Roll every check with run_code.",
          builtinTools: [],
        }),
      ),
    ).toThrow(/commands "run_code" and `builtinTools` declares none/);
  });

  test("a resolver that cannot answer from a bare context is REFUSED, not silently defaulted", () => {
    // The honest arm: a resolver reaching for something a bare session has no
    // value for. Falling back to the framework default here is the outcome that
    // must not exist — a green from a check that inspected nothing.
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({
          name: "Cavern",
          systemPrompt: (ctx) => {
            const url = ctx.env.PROMPT_URL;
            if (url === undefined) throw new Error("PROMPT_URL is unset");
            return `Fetch the brief from ${url}, then use run_code.`;
          },
          builtinTools: ["run_code"],
        }),
      ),
    ).toThrow(/`systemPrompt` is a resolver and calling it threw.*builtinTools/s);
  });

  test("a resolver answering no prompt at all is refused too", () => {
    // The other way a resolver can leave nothing to scan. Falling through to
    // the framework default here would be the same green-on-nothing.
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({
          name: "Cavern",
          systemPrompt: () => "",
          builtinTools: ["run_code"],
        }),
      ),
    ).toThrow(/is a resolver and it answered "" rather than a prompt/);
  });

  test("the converse is not asserted: an undeclared-in-prose builtin is fine", () => {
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({
          name: "Scout",
          systemPrompt: "Begin with a web_search call.",
          builtinTools: ["web_search", "visit_webpage"],
        }),
      ),
    ).not.toThrow();
  });
});
