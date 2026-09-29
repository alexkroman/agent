// Copyright 2026 the AAI authors. MIT license.
/**
 * The prompt↔builtin scan, over prompts written in place.
 *
 * Two halves are worth pinning, and each has a direction that fails a CORRECT
 * agent if it regresses: the single-word rule must find `think` where a prompt
 * names it and must NOT find it in "think before you answer", and a custom tool
 * replacing a builtin must count as declaring it.
 */

import { describe, expect, test } from "vitest";
import { agent } from "./define.ts";
import { expectDeployable } from "./testing-deployable.ts";
import { commandedBuiltins, expectPromptBuiltinsDeclared } from "./testing-prompt-builtins.ts";

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
      expectPromptBuiltinsDeclared(
        agent({ name: "Coda", systemPrompt: "Call run_code.", builtinTools: [] }),
      ),
    ).toThrow(/declares none/);
  });

  test("an unset `builtinTools` reports the default surface, not 'none'", () => {
    // An unset field is what a deploy serves as `["think"]`, and saying
    // "declares none" there would be false.
    expect(() =>
      expectPromptBuiltinsDeclared(agent({ name: "Coda", systemPrompt: "Call run_code." })),
    ).toThrow(/declares think, with no custom tool/);
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

describe("commandedBuiltins — single-word builtins", () => {
  test.each([
    ["in backticks", "Before a hard answer, call `think` with your plan.", ["think"]],
    ["in backticks with parens", "Work sums out with `calculate()`.", ["calculate"]],
    ["as the noun before 'tool'", "Use the calculate tool for tips and splits.", ["calculate"]],
    ["after an article other than 'the'", "You have a think tool; use it.", ["think"]],
    ["as the object of 'use'", "Use calculate for anything past mental arithmetic.", ["calculate"]],
    ["as the object of 'call'", "Always call recall before asking their name.", ["recall"]],
    ["as the object of 'invoke'", "Invoking remember saves a fact for later.", ["remember"]],
  ])("found %s", (_label, systemPrompt, expected) => {
    expect(commandedBuiltins({ systemPrompt })).toEqual(expected);
  });

  test.each([
    ["the verb 'think'", "Think before you answer, and keep it short."],
    ["the verb 'calculate'", "Calculate the tip in your head when it is round."],
    ["'remember' and 'recall' as prose", "Remember their name, and recall it when they return."],
    ["a capitalized word", "Use Think for nothing; this is prose about Calculate."],
    ["a hyphenated compound", "Use think-aloud reasoning only in your head."],
    ["'called' naming a concept", "A technique called recall helps students."],
    ["a verb before 'tools' with no article", "Think tools through before you pick one."],
    ["an inflected form", "It thinks, it calculates, it remembers."],
  ])("NOT found in %s", (_label, systemPrompt) => {
    expect(commandedBuiltins({ systemPrompt })).toEqual([]);
  });

  test("orders single-word and snake_case mentions by where the NAME sits", () => {
    const systemPrompt = "Look it up with web_search, use `think` to plan, then call run_code.";
    expect(commandedBuiltins({ systemPrompt })).toEqual(["web_search", "think", "run_code"]);
  });

  test("a name mentioned in two positions is listed once", () => {
    const systemPrompt =
      "Use calculate for sums. The calculate tool is exact; `calculate` never guesses.";
    expect(commandedBuiltins({ systemPrompt })).toEqual(["calculate"]);
  });
});

describe("expectPromptBuiltinsDeclared — a custom tool of the same name", () => {
  test("a custom tool replacing a builtin counts as declaring it", () => {
    // The shape a deployed def has: `tools` filled from `tools/*.ts`, and
    // `builtinTools` not naming the one the agent replaced with its own.
    const def = {
      systemPrompt: "When they ask for a link, send it with text_me.",
      builtinTools: ["web_search"] as const,
      tools: { text_me: { description: "Text the household.", execute: () => ({}) } },
    };
    expect(expectPromptBuiltinsDeclared(def)).toEqual(["text_me"]);
  });

  test("a custom tool under a DIFFERENT name does not stand in for a builtin", () => {
    const def = {
      systemPrompt: "When they ask for a link, send it with text_me.",
      builtinTools: [] as const,
      tools: { send_sms: { description: "Text the household.", execute: () => ({}) } },
    };
    expect(() => expectPromptBuiltinsDeclared(def)).toThrow(
      /commands "text_me" and `builtinTools` declares none, with no custom tool of that name/,
    );
  });

  test("a single-word builtin the prompt names is checked like any other", () => {
    expect(() =>
      expectPromptBuiltinsDeclared(
        agent({ name: "Abacus", systemPrompt: "Use the calculate tool.", builtinTools: [] }),
      ),
    ).toThrow(/commands "calculate"/);
  });
});
