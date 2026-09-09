// Copyright 2026 the AAI authors. MIT license.
// `studioBundleAccess` — the pair `test_agent` is built out of, which was an
// inline object in `harness.ts` until a second caller (the studio eval harness,
// `studio/_eval-harness.ts`) wanted the REAL one rather than a double.
//
// What is worth pinning is not the shape (`HarnessBundleAccess` is that) but the
// answers a MODEL reads — every one of them prose, because the consumer is a
// tool result and not a caller catching an exception — and the one thing a
// snapshot of `state` would have got wrong: the access object is built once per
// session while `test_agent` loads and then trials in the same tool call, so it
// has to read `state.agent` at CALL time.
//
// The agent fixture is a plain object rather than an `agent()` definition, and
// deliberately: what a trial holds is a TENANT's loaded bundle, typed
// structurally by this package's own `AgentDef` (`harness/types.ts`), and
// reaching for the SDK's factory here would assert against a shape the loader
// never produces.

import { describe, expect, test } from "vitest";
import { emptyHarnessState } from "../harness/bundle.ts";
import type { AgentDef } from "../harness/types.ts";
import { studioBundleAccess } from "./bundle-access.ts";

const TRIAL_AGENT: AgentDef = {
  name: "Trial",
  systemPrompt: "p",
  greeting: "g",
  tools: {
    echo: {
      description: "echo the text back",
      execute: (args) => `echo:${(args as { text: string }).text}`,
    },
    blows_up: {
      description: "always throws",
      execute: () => {
        throw new Error("nope");
      },
    },
    says_nothing: {
      description: "answer with no result at all",
      // A VOID tool, not one answering `""`: the trial serializes a non-string
      // result with `JSON.stringify`, which answers `undefined` for this — and
      // `undefined` is the only input the `?? "(no result)"` below has ever
      // had. An empty string is a result, and passes through as one.
      execute: () => undefined,
    },
  },
};

describe("studioBundleAccess", () => {
  test("refuses a trial before anything is loaded, in prose the model can read", async () => {
    const access = studioBundleAccess(emptyHarnessState());
    await expect(access.executeTool("echo", { text: "hi" })).resolves.toBe(
      "Tool error: agent not loaded",
    );
  });

  test("reads state.agent at CALL time, not when the access object was built", async () => {
    const state = emptyHarnessState();
    // Built while nothing is loaded — the order `handleStudioRequest` uses, and
    // the reason `test_agent` can load and trial in one call.
    const access = studioBundleAccess(state);
    state.agent = TRIAL_AGENT;
    await expect(access.executeTool("echo", { text: "hi" })).resolves.toBe("echo:hi");
  });

  test("shapes a throw, a void answer and an unknown name into distinguishable prose", async () => {
    const state = emptyHarnessState();
    state.agent = TRIAL_AGENT;
    const access = studioBundleAccess(state);
    await expect(access.executeTool("blows_up", {})).resolves.toBe("Tool error: nope");
    await expect(access.executeTool("says_nothing", {})).resolves.toBe("(no result)");
    await expect(access.executeTool("not_a_tool", {})).resolves.toBe(
      "Tool error: Unknown tool: not_a_tool",
    );
  });

  test("an inspection load carries an EMPTY env, whatever the harness holds", async () => {
    const state = emptyHarnessState();
    // A deployed harness has the tenant's provider credentials in `state.env`;
    // a studio load is an INSPECTION and must not resolve them, so the loader
    // is handed `{}` — which is also what lets a studio `test_agent` load a
    // bundle whose deployed session would need a key nobody has here.
    state.env = Object.freeze({ ASSEMBLYAI_API_KEY: "host-key-must-not-reach-a-trial-load" });
    const access = studioBundleAccess(state);
    const loaded = await access.loadBundle(
      `export const __aaiConfig = { name: "Loaded", toolSchemas: [] };
export const __aaiCreateRuntime = () => ({
  startSession: () => undefined,
  shutdown: () => Promise.resolve(),
});
export default { name: "Loaded", systemPrompt: "p", greeting: "g", tools: {} };
`,
    );
    expect(loaded.config).toMatchObject({ name: "Loaded" });
    // The load REPLACED the loaded agent, which is the state a trial then
    // reads — the reason `studioBundleAccess` cannot snapshot `state`.
    expect(state.agent?.name).toBe("Loaded");
    // And it replaced `state.env` with the empty one, which is worth pinning
    // because it is the surprising half: `loadBundle` assigns
    // `state.env = {...params.env}`, so an inspection load CLEARS whatever the
    // harness held. Benign as the modes stand — a studio sandbox serves one
    // project for its whole life and never also runs agent mode, so
    // `state.env` is `{}` there anyway — and it would not be if one process
    // ever did both. This assertion is where that would be noticed.
    expect(state.env).toEqual({});
  });
});
