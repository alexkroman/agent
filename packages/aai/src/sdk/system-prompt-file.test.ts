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
import type { AgentSessionContext } from "./agent-session-context.ts";
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

  test("a RESOLVER is left exactly as the author built it", () => {
    // The case that shipped broken: `systemPrompt` was widened to accept a
    // per-request resolver and this function threw on every one of them, so the
    // capability was unreachable from the 20 of 29 templates that keep a
    // `system-prompt.md`. There is nothing to search a function for — its text
    // does not exist until a session asks for it — so the check outcome 4 makes
    // is undecidable here, and refusing bought nothing.
    const resolve = (ctx: AgentSessionContext) => `${FILE}\n\nSession ${ctx.sessionId}.`;
    const authored = agent({ name: "T", systemPrompt: resolve });
    const lowered = withSystemPrompt(authored, FILE);
    expect(lowered).toBe(authored);
    expect(lowered.systemPrompt).toBe(resolve);
  });

  test("a resolver that never reads the file is left alone too", () => {
    // Deliberate, and the price of the arm above: an author who declared a
    // function owns composing the prompt, and whether the closure reached for
    // `system-prompt.md?raw` is not something a value comparison can see.
    const authored = agent({ name: "T", systemPrompt: () => "Computed, and not the file." });
    expect(() => withSystemPrompt(authored, FILE)).not.toThrow();
  });

  test("an empty file still throws for a resolver — the file itself is the fault", () => {
    // The empty-file arm runs BEFORE the resolver arm, and should: a file with
    // nothing in it is a mistake whatever `agent.ts` declares.
    expect(() => withSystemPrompt(agent({ name: "T", systemPrompt: () => "x" }), " \n")).toThrow(
      /is empty/,
    );
  });

  test("a file nothing reads throws, naming what to do about it", () => {
    const authored = agent({ name: "T", systemPrompt: "Inline, and not the file." });
    expect(() => withSystemPrompt(authored, FILE)).toThrow(/nothing reads it/);
    // And it names STRING, because that is the only arm left that can throw
    // this — the message used to offer "import the file and compose it" as the
    // remedy for a resolver, which produced another function and threw again.
    expect(() => withSystemPrompt(authored, FILE)).toThrow(/`systemPrompt` string/);
    expect(() => withSystemPrompt(authored, FILE)).toThrow(/systemPrompt: \(ctx\) =>/);
  });

  test("an empty or whitespace-only file throws rather than falling through", () => {
    // Silently taking DEFAULT_SYSTEM_PROMPT here would ship an agent running on
    // the framework's prompt while a file in the tree claims otherwise.
    expect(() => withSystemPrompt(agent({ name: "T" }), "   \n\n")).toThrow(/is empty/);
  });
});
