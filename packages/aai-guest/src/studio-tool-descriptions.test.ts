// Copyright 2026 the AAI authors. MIT license.
/**
 * The prose and the numbers the coding agent's tools are described with.
 *
 * There is no snapshot here on purpose: the descriptions are TUNED, and a
 * snapshot of prose fails on every improvement while catching none of the two
 * things that actually go wrong. Those two are what this file asserts.
 *
 * 1. **A description with no tool, or a tool with no description.** The map is
 *    keyed by tool name and read by `studio-tools.ts` / `studio-project-tools.ts`
 *    / `studio-template-tools.ts` at construction, so a renamed tool leaves a
 *    dead entry behind and a new one ships with `undefined` as its description —
 *    which the model reads as a tool it has no idea how to use.
 * 2. **A quoted number the code does not enforce.** The limits live in this
 *    module and are imported back for enforcement precisely so the two cannot
 *    disagree; a description that names a different number than the code
 *    enforces is worse than one that names none.
 *
 * UNIT tier: two constant maps and one tool call whose argument is rejected
 * before anything is dispatched — no filesystem, no subprocess, no network.
 */

import { describe, expect, test } from "vitest";
import { runTool } from "./_test-utils.ts";
import { createStudioAgent } from "./studio-agent.ts";
import { createLogsTool } from "./studio-logs-tool.ts";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  GLOB_LIMIT,
  LOGS_TOOL_MAX_LINES,
  READ_LIMIT,
  STUDIO_TOOL_DESCRIPTIONS,
} from "./studio-tool-descriptions.ts";

/** The tools the agent DECLARES — the builtins carry the SDK's own prose. */
function declaredToolNames(): string[] {
  const def = createStudioAgent(
    {
      dir: import.meta.dirname,
      scope: "user:1",
      project: "p",
      files: {},
      apiKey: "k",
      chatToken: "t",
      system: "s",
      model: "fake-1",
      maxSteps: 8,
    },
    {
      loadBundle: async () => ({}),
      executeTool: async () => "",
      typecheck: async () => ({ ok: true, skipped: false }),
    },
  );
  return Object.keys(def.tools).sort();
}

describe("the studio tool descriptions", () => {
  test("describe exactly the tools the agent declares", () => {
    expect(Object.keys(STUDIO_TOOL_DESCRIPTIONS).sort()).toEqual(declaredToolNames());
  });

  test.each(Object.entries(STUDIO_TOOL_DESCRIPTIONS))("%s reads as real prose", (_name, text) => {
    expect(text.trim()).toBe(text);
    expect(text.length).toBeGreaterThan(40);
    // A description is a template literal, so a limit that was renamed out
    // from under one lands in the model's context as a word.
    expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
    // The first line is what a tool list renders; it has to say what the tool
    // does on its own.
    expect(text.split("\n")[0]?.length ?? 0).toBeGreaterThan(20);
  });

  test("quote the same numbers the code enforces", () => {
    // Each of these is imported back by the module that enforces it —
    // studio-tools.ts for the first three, studio-logs-tool.ts for the last.
    expect(STUDIO_TOOL_DESCRIPTIONS.glob).toContain(String(GLOB_LIMIT));
    expect(STUDIO_TOOL_DESCRIPTIONS.bash).toContain(`default ${BASH_TIMEOUT_MS}ms`);
    expect(STUDIO_TOOL_DESCRIPTIONS.bash).toContain(`max ${BASH_TIMEOUT_MAX_MS}ms`);
    // Ordering, so a swap of the two bash budgets cannot pass: the default
    // must be reachable under the cap.
    expect(BASH_TIMEOUT_MS).toBeLessThan(BASH_TIMEOUT_MAX_MS);
    expect(STUDIO_TOOL_DESCRIPTIONS.read_file).toContain("offset/limit");
    expect(READ_LIMIT).toBeGreaterThan(0);
    expect(LOGS_TOOL_MAX_LINES).toBeGreaterThan(0);
  });

  test("read_logs refuses more lines than its own limit admits", async () => {
    // The consistency that matters most, because the other side of it is a
    // REMOTE clamp this package may not import (`MAX_LOG_TOOL_LINES` in
    // aai-studio-server): asking for more than the host admits has to be a
    // rejected argument here, not a rejected RPC there. No host channel is
    // installed, so a call that got past validation would fail differently.
    const tools = createLogsTool();
    const out = await runTool(tools, "read_logs", { limit: LOGS_TOOL_MAX_LINES + 1 });
    expect(JSON.parse(out)).toMatchObject({
      error: expect.stringContaining('Invalid arguments for tool "read_logs"'),
    });
    // (The number itself is quoted on the `limit` PARAMETER's own
    // description rather than in this prose, which is why the assertion above
    // is on the refusal.)
  });

  test("the read_logs description tells the agent which agent it is reading", () => {
    // The tool reads ANOTHER guest's ring — never its own — and the two
    // environments are the only thing the caller chooses, so both have to be
    // named or the model guesses.
    const text = STUDIO_TOOL_DESCRIPTIONS.read_logs;
    expect(text).toContain("preview");
    expect(text).toContain("production");
  });
});
