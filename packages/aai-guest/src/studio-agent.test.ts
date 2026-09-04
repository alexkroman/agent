// Copyright 2026 the AAI authors. MIT license.
/**
 * The coding agent's tool REGISTRY, and the session it is bound to.
 *
 * `createStudioAgent` is the one place the studio's tool set is assembled, so
 * it is also the one place a tool can silently drop out of the agent — and the
 * symptom is not a failure: the turn runs, the model simply never calls the
 * tool, and a starter eval reports that as the model choosing not to. Hence
 * the shape of these tests: every FAMILY is named by a tool the family alone
 * contributes, so deleting a spread from that function fails here rather than
 * degrading a score.
 *
 * Kept to the UNIT tier, which forbids filesystem WRITES: nothing here
 * materializes a workspace. The one test that has to prove a tool is really
 * bound to its session's directory does it by READING two directories that
 * already exist in the checkout (this file's own, and the toolchain's), which
 * is the same evidence a temp dir would give without leaving the tier.
 * Behaviour that needs a real tree — the post-write diagnostics, the path
 * jail — is already covered against one in `studio-tools.test.ts`.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import { runTool } from "./_test-utils.ts";
import { createStudioAgent, STUDIO_TOOL_TIMEOUT_MS, type StudioAgentDeps } from "./studio-agent.ts";
import type { StudioSession } from "./studio-session.ts";
import { STUDIO_TOOL_LABELS } from "./studio-tools.ts";

/** This package's `src/`, which holds the module under test. */
const SRC_DIR = import.meta.dirname;
/** A second real directory, with none of `src/`'s files in it. */
const TOOLCHAIN_DIR = path.join(import.meta.dirname, "..", "toolchain");

function makeSession(over: Partial<StudioSession> = {}): StudioSession {
  return {
    dir: SRC_DIR,
    scope: "user:1",
    project: "p",
    files: {},
    apiKey: "caller-key",
    chatToken: "chat-token",
    system: "You are a coding agent.",
    model: "fake-1",
    maxSteps: 8,
    ...over,
  };
}

const deps: StudioAgentDeps = {
  loadBundle: async () => ({}),
  executeTool: async () => "",
  typecheck: async () => ({ ok: true, skipped: false }),
};

const makeAgent = (over: Partial<StudioSession> = {}) => createStudioAgent(makeSession(over), deps);

/** The definition's builtins, asserted present so a spec never reads `undefined`. */
function declaredBuiltins(): readonly string[] {
  const builtins = makeAgent().builtinTools;
  if (!builtins) throw new Error("the studio agent declares no builtinTools");
  return builtins;
}

describe("the studio coding agent's definition", () => {
  test("declares the text mode, the session's prompt, model and step budget", () => {
    const def = makeAgent();
    // `text: true` is what makes `createTextAgent` accept the definition and
    // `createRuntime` refuse it — the coding agent has no audio path at all.
    expect(def.text).toBe(true);
    expect(def.systemPrompt).toBe("You are a coding agent.");
    expect(def.maxSteps).toBe(8);
    expect(def.name).toBe("AAI Studio");
    // The model is host configuration delivered by `studio/session-init`; the
    // KEY is the caller's and must never ride on the definition.
    expect(JSON.stringify(def)).not.toContain("caller-key");
  });

  test("names the three web builtins rather than adapting them", () => {
    // NAMED is the whole point: `builtinTools` lands them in the same executor
    // as everything else, with a real `ctx`. Present as `tools` entries would
    // mean the hand-written adapter is back.
    expect(declaredBuiltins()).toEqual(["visit_webpage", "get_page_design", "web_search"]);
    for (const name of declaredBuiltins()) expect(makeAgent().tools).not.toHaveProperty(name);
  });

  // Each name is contributed by exactly ONE spread in `createStudioAgent`, so a
  // family that stops being merged fails on its own row.
  test.each([
    ["workspace tools", "write_file"],
    ["workspace tools (search)", "grep"],
    ["the in-guest build", "test_agent"],
    ["project tools", "add_dependency"],
    ["project tools (registry)", "npm_info"],
    ["template tools", "use_template"],
    ["template tools (listing)", "list_templates"],
    ["the logs tool", "read_logs"],
    ["design inspiration", "generate_design_inspiration"],
    ["the plan tool", "todo_write"],
  ])("serves %s (%s)", (_family, name) => {
    expect(makeAgent().tools).toHaveProperty(name);
  });

  test("every tool it exposes has a browser label, and no label is stale", () => {
    // `STUDIO_TOOL_LABELS` is served to the browser by `GET /studio/tools`, so
    // a missing entry shows the user a raw snake_case name and an extra one is
    // dead weight. (Also asserted from the tools side in studio-tools.test.ts;
    // this is the assertion the registry itself owes.)
    const exposed = [...Object.keys(makeAgent().tools), ...declaredBuiltins()].sort();
    expect(Object.keys(STUDIO_TOOL_LABELS).sort()).toEqual(exposed);
    for (const label of Object.values(STUDIO_TOOL_LABELS)) expect(label).not.toBe("");
  });

  test("the per-call tool deadline is well above the SDK's voice budget", () => {
    // 120s, passed to `createTextAgent` as `toolTimeoutMs` — see studio-chat.ts.
    // The number matters in one direction: these tools install packages and
    // type-check workspaces, and the SDK's 30s default is a budget sized for a
    // caller listening to silence.
    expect(STUDIO_TOOL_TIMEOUT_MS).toBe(120_000);
    expect(STUDIO_TOOL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test("a registry rebuilt for a second session never serves the first one's tools", async () => {
    // The module's stated reason for existing: the tools close over ONE
    // session's directory, and a re-installed session (a refresh, a replica
    // taking over) must not be handed tools bound to the previous tree.
    const first = makeAgent({ dir: SRC_DIR });
    const second = makeAgent({ dir: TOOLCHAIN_DIR });
    const glob = async (def: ReturnType<typeof makeAgent>, pattern: string) =>
      await runTool(def.tools, "glob", { pattern });

    // Built second, so a memoized registry or a shared closure would show up
    // as the first agent answering for the toolchain directory.
    expect(await glob(second, "package.json")).toBe("package.json");
    expect(await glob(second, "studio-agent.ts")).toBe("No files found");
    expect(await glob(first, "studio-agent.ts")).toBe("studio-agent.ts");
    expect(await glob(first, "package.json")).toBe("No files found");
    // Distinct tool objects, not merely distinct answers.
    expect(second.tools.glob).not.toBe(first.tools.glob);
  });
});
