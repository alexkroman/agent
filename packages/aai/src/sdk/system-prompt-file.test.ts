// Copyright 2026 the AAI authors. MIT license.
/**
 * The four outcomes of attaching a discovered `system-prompt.md`.
 *
 * `aai-cli`'s `worker-bundler.test.ts` drives the same rules through a real Vite
 * pass, which is what proves the lowering resolves; these pin the DECISION,
 * which is the half that has to be right for a composed prompt not to be called
 * a mistake.
 */

import { describe, expect, test } from "vitest";
import type { AgentSystemPrompt } from "./agent-instructions.ts";
import type { AgentSessionContext } from "./agent-session-context.ts";
import { agent } from "./define.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { withSystemPrompt } from "./system-prompt-file.ts";

const FILE = "You are terse.\n\n- One sentence.\n";

/** A def a HOST built: the lowered def with a prompt of its own — `agent()` refuses the key. */
const hosted = (systemPrompt: AgentSystemPrompt) => ({ ...agent({ name: "T" }), systemPrompt });

describe("withSystemPrompt", () => {
  test("the file becomes the prompt of every def agent() returns", () => {
    const def = withSystemPrompt(agent({ name: "T" }), FILE);
    expect(def.systemPrompt).toBe(FILE);
  });

  test("a promptContext does not trip the comparison, and rides through for the builder", () => {
    // Static or a resolver, the context is not the prompt: the file still
    // becomes the prompt (outcome 1) and the context stays its own field, so
    // the file is not declared twice and `buildSystemPrompt` appends it.
    const withText = withSystemPrompt(agent({ name: "T", promptContext: "Specials: soup." }), FILE);
    expect(withText.systemPrompt).toBe(FILE);
    expect(withText.promptContext).toBe("Specials: soup.");
    const resolver = (_ctx: AgentSessionContext) => "live";
    const withFn = withSystemPrompt(agent({ name: "T", promptContext: resolver }), FILE);
    expect(withFn.systemPrompt).toBe(FILE);
    expect(withFn.promptContext).toBe(resolver);
  });

  test("a NEW def, so the shared module export is not rewritten under a spec", () => {
    // Same reason `withTools` returns a new object: the def a module
    // default-exports is shared, and a loader mutating it makes the order of two
    // imports decide what an agent is.
    const authored = agent({ name: "T" });
    expect(withSystemPrompt(authored, FILE)).not.toBe(authored);
    expect(authored.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("a def the file was already applied to is left alone — the lowering is idempotent", () => {
    const once = withSystemPrompt(agent({ name: "T" }), FILE);
    expect(withSystemPrompt(once, FILE)).toBe(once);
  });

  test("a host prompt CONTAINING the file is left exactly as built", () => {
    // The value comparison is what makes this need no special case — and what
    // makes the "is the file applied?" question answerable at all, since the
    // entry is generated before the build and has no module graph to ask.
    const composed = hosted(`${FILE}\nTODAY: fish`);
    expect(withSystemPrompt(composed, FILE).systemPrompt).toBe(composed.systemPrompt);
  });

  test("a RESOLVER is left exactly as the host built it", () => {
    // There is nothing to search a function for — its text does not exist
    // until a session asks for it — so the check outcome 4 makes is
    // undecidable here, and a host that composes the whole prompt per session
    // owns it.
    const resolve = (ctx: AgentSessionContext) => `${FILE}\n\nSession ${ctx.sessionId}.`;
    const built = hosted(resolve);
    const lowered = withSystemPrompt(built, FILE);
    expect(lowered).toBe(built);
    expect(lowered.systemPrompt).toBe(resolve);
    expect(() =>
      withSystemPrompt(
        hosted(() => "Computed, and not the file."),
        FILE,
      ),
    ).not.toThrow();
  });

  test("an empty file still throws for a resolver — the file itself is the fault", () => {
    // The empty-file arm runs BEFORE the resolver arm, and should: a file with
    // nothing in it is a mistake whatever the def carries.
    expect(() =>
      withSystemPrompt(
        hosted(() => "x"),
        " \n",
      ),
    ).toThrow(/is empty/);
  });

  test("a file nothing reads throws, naming what to do about it", () => {
    // Only a raw `export default {...}` or a host can put a different STRING
    // there; the sentence says so and names `promptContext` for computed text.
    const raw = hosted("Inline, and not the file.");
    expect(() => withSystemPrompt(raw, FILE)).toThrow(/nothing reads it/);
    expect(() => withSystemPrompt(raw, FILE)).toThrow(/The file IS the prompt/);
    expect(() => withSystemPrompt(raw, FILE)).toThrow(/promptContext/);
  });

  test("an empty or whitespace-only file throws rather than falling through", () => {
    // Silently taking DEFAULT_SYSTEM_PROMPT here would ship an agent running on
    // the framework's prompt while a file in the tree claims otherwise.
    expect(() => withSystemPrompt(agent({ name: "T" }), "   \n\n")).toThrow(/is empty/);
  });
});
