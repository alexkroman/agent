// Copyright 2026 the AAI authors. MIT license.
/**
 * The three outcomes of attaching a discovered `system-prompt.md`.
 *
 * `aai-cli`'s `worker-bundler.test.ts` drives the same rules through a real Vite
 * pass, which is what proves the lowering resolves; these pin the DECISION,
 * which is the half that has to be right for a composed prompt not to be called
 * a mistake.
 */

import { describe, expect, test } from "vitest";
import { agent } from "./define.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { withSystemPrompt } from "./system-prompt-file.ts";

const FILE = "You are terse.\n\n- One sentence.\n";

describe("withSystemPrompt", () => {
  test("the file becomes the prompt when the agent declared none", () => {
    const def = withSystemPrompt(agent({ name: "T" }), FILE);
    expect(def.systemPrompt).toBe(FILE);
  });

  test("a NEW def, so the shared module export is not rewritten under a spec", () => {
    // Same reason `withTools` returns a new object: the def a module
    // default-exports is shared, and a loader mutating it makes the order of two
    // imports decide what an agent is.
    const authored = agent({ name: "T" });
    expect(withSystemPrompt(authored, FILE)).not.toBe(authored);
    expect(authored.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("an explicit prompt equal to the file is left alone", () => {
    const authored = agent({ name: "T", systemPrompt: FILE });
    expect(withSystemPrompt(authored, FILE)).toBe(authored);
  });

  test("a COMPOSED prompt containing the file is left exactly as built", () => {
    // `pizza-ordering-agent`'s shape: the file plus a computed menu. The value
    // comparison is what makes this need no special case — and what makes the
    // "is the file referenced?" question answerable at all, since the entry is
    // generated before the build and has no module graph to ask.
    const composed = `${FILE}\nTODAY: fish`;
    const authored = agent({ name: "T", systemPrompt: composed });
    expect(withSystemPrompt(authored, FILE).systemPrompt).toBe(composed);
  });

  test("a THUNK composing the file is left alone — and stays a thunk", () => {
    // The dynamic form of the case above: the recipe the outcome-3 message
    // teaches, wrapped so the prompt can carry something per turn. Lowering the
    // file onto it would freeze exactly what the author made move.
    let turn = 0;
    const authored = agent({ name: "T", systemPrompt: () => `${FILE}\nTURN: ${++turn}` });
    const lowered = withSystemPrompt(authored, FILE);
    expect(lowered).toBe(authored);
    expect(typeof lowered.systemPrompt).toBe("function");
  });

  test("the thunk is called ONCE, for the comparison, and its answer discarded", () => {
    let calls = 0;
    const authored = agent({
      name: "T",
      systemPrompt: () => {
        calls += 1;
        return FILE;
      },
    });
    withSystemPrompt(authored, FILE);
    expect(calls).toBe(1);
  });

  test("a thunk that never reads the file throws like any other unread file", () => {
    // Outcome 1 cannot rescue it: a function is never the framework default, so
    // an agent declaring one owns its prompt and an ignored file is a mistake.
    const authored = agent({ name: "T", systemPrompt: () => "Inline, and not the file." });
    expect(() => withSystemPrompt(authored, FILE)).toThrow(/nothing reads it/);
  });

  test("a file nothing reads throws, naming what to do about it", () => {
    const authored = agent({ name: "T", systemPrompt: "Inline, and not the file." });
    expect(() => withSystemPrompt(authored, FILE)).toThrow(/nothing reads it/);
  });

  test("an empty or whitespace-only file throws rather than falling through", () => {
    // Silently taking DEFAULT_SYSTEM_PROMPT here would ship an agent running on
    // the framework's prompt while a file in the tree claims otherwise.
    expect(() => withSystemPrompt(agent({ name: "T" }), "   \n\n")).toThrow(/is empty/);
  });
});
