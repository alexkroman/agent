// Copyright 2026 the AAI authors. MIT license.
/**
 * `openEvalWorkflows`, the credential gate under it, and both suites it serves.
 *
 * Three things are asserted rather than assumed:
 *
 * - **The credential gate**, because the wrong answer is SILENT: a workflow app
 *   declares no providers, so asking `evalCredentials` reports it ready and every
 *   keyless case goes live and dies on a 401 inside a step.
 * - **A voice agent's tool really starting a run**, which is the gap the whole
 *   `workflows` seam exists for and which no assertion about the client alone
 *   can cover — the runtime has to have been handed it.
 * - **What the harness will NOT claim**: a cancelled run's body ran on, and a
 *   `ctx.sleep` was recorded rather than taken.
 */

import { type AgentDef, agent, tool, workflow } from "@alexkroman1/aai";
import { report, stepEnv } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { describeWorkflowEval } from "./describe-workflows.ts";
import { openEvalSession } from "./session.ts";
import { installStubLlm } from "./stub-llm.ts";
import {
  completedOutput,
  type EvalWorkflowRun,
  type EvalWorkflows,
  evalWorkflowCredentials,
  openEvalWorkflows,
} from "./workflows.ts";

/** How long `digest` asks to wait. Recorded, never taken. */
const SLEEP_MS = 10_000;

const digest = workflow({
  description: "Digest a link",
  input: z.object({ url: z.string() }),
  run: async (input: { url: string }, ctx) => {
    await report(`reading ${input.url}`);
    await ctx.sleep("nap", SLEEP_MS);
    return { headline: `about ${input.url}` };
  },
});

/** Reads a DECLARED credential from inside the body, through the published slot. */
const keyReader = workflow({
  input: z.object({}),
  run: async () => ({ key: stepEnv("A_KEY_NOBODY_HAS") }),
});

const failing = workflow({
  input: z.object({ why: z.string() }),
  run: async (input: { why: string }) => {
    throw new Error(input.why);
  },
});

const app = agent({
  name: "Digest App",
  page: "static",
  workflows: { digest, failing },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});

/** Closed after every test — `openEvalWorkflows` publishes process-global slots. */
let open: EvalWorkflows | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

function openApp(def: AgentDef = app): EvalWorkflows {
  open = openEvalWorkflows({ agent: def, env: { ASSEMBLYAI_API_KEY: "k" } });
  return open;
}

describe("evalWorkflowCredentials", () => {
  test("reads requiredEnv, which is the only thing a workflow app names a key in", () => {
    // The bug this exists to prevent: `requiredProviderEnvVars` answers `[]` for
    // a `page: "static"` agent, so the provider gate alone reports every workflow
    // app ready.
    const missing = evalWorkflowCredentials(app, {});
    expect(missing.ready).toBe(false);
    expect(missing.missing).toEqual(["ASSEMBLYAI_API_KEY"]);
    expect(missing.reason).toContain("ASSEMBLYAI_API_KEY");
  });

  test("is ready once the host carries every declared key, and copies it", () => {
    const found = evalWorkflowCredentials(app, { ASSEMBLYAI_API_KEY: "k" });
    expect(found.ready).toBe(true);
    expect(found.env.ASSEMBLYAI_API_KEY).toBe("k");
  });

  test("copies DECLARED keys only, so no unrelated shell variable reaches a step", () => {
    const declared = agent({
      name: "Slack App",
      page: "static",
      workflows: { digest },
      requiredEnv: ["SLACK_WEBHOOK_URL"],
    });
    const found = evalWorkflowCredentials(declared, {
      SLACK_WEBHOOK_URL: "https://hooks.example/x",
      MY_LAPTOP_SECRET: "nope",
    });
    expect(found.env.SLACK_WEBHOOK_URL).toBe("https://hooks.example/x");
    expect(found.env.MY_LAPTOP_SECRET).toBeUndefined();
  });
});

describe("openEvalWorkflows", () => {
  test("refuses an agent that declares none, rather than handing back a rejecting client", () => {
    expect(() => openEvalWorkflows({ agent: agent({ name: "No Workflows" }) })).toThrow(
      /declares no workflows/,
    );
  });

  test("runs a workflow and reports what it returned, narrated and slept", async () => {
    const run = await openApp().run(digest, { url: "https://example.test/post" });

    expect(run.status).toBe("completed");
    expect(run.completed).toBe(true);
    expect(run.workflow).toBe("digest");
    expect(run.output).toEqual({ headline: "about https://example.test/post" });
    expect(run.reported).toEqual(["reading https://example.test/post"]);
    // The honest report: the body ASKED for ten seconds and the harness did not
    // wait, because a suspension is the property it cannot reproduce.
    expect(run.slept).toEqual([{ label: "nap", duration: SLEEP_MS }]);
    expect(run.error).toBeUndefined();
  });

  test("the snapshot is the production union, so a case can narrow on it", async () => {
    const run = await openApp().run(digest, { url: "https://example.test/post" });
    if (run.snapshot.status !== "completed") expect.fail("expected a completed run");
    expect(run.snapshot.output).toEqual({ headline: "about https://example.test/post" });
    expect(run.snapshot.runId).toBe(run.runId);
  });

  test("validates the input through the REAL client, so a bad payload fails at the call", async () => {
    // The validation is `createWorkflowClient`'s, not the harness's — which is
    // the point of building the real client over a fake engine.
    await expect(openApp().run("digest", { url: 42 })).rejects.toThrow(/Invalid input/);
  });

  test("names the declared set when a workflow is not one of them", async () => {
    await expect(openApp().run("nope", {})).rejects.toThrow(/digest/);
  });

  test("a failing body is a failed run carrying its message", async () => {
    const run = await openApp().run(failing, { why: "the brief is too short" });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("too short");
    expect(run.output).toBeUndefined();
  });

  test("records a correlation key in the real index, so `find` answers", async () => {
    const active = openApp();
    const run = await active.run(digest, { url: "https://a.test" }, { key: "caller-42" });
    const found = await active.client.find(digest, "caller-42");
    expect(found.map((one) => one.runId)).toEqual([run.runId]);
  });

  test("`runs()` reports every run without waiting for any", async () => {
    const active = openApp();
    await active.run(digest, { url: "https://a.test" });
    await active.run(digest, { url: "https://b.test" });
    const all = await active.runs();
    expect(all).toHaveLength(2);
    expect(all.map((one) => one.workflow)).toEqual(["digest", "digest"]);
  });

  test("`settle` refuses a run it never started, which is the only honest answer", async () => {
    await expect(openApp().settle("run-from-nowhere")).rejects.toThrow(/did not start run/);
  });

  test("a run that outlasts its timeout says what it was doing", async () => {
    const stuck = workflow({
      input: z.object({}),
      // Deliberately never settles: the assertion is about the harness's own
      // deadline, and the message is the part with any value in it.
      run: async () => {
        await report("thinking about it");
        await new Promise(() => undefined);
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Stuck", page: "static", workflows: { stuck } }),
      env: {},
      timeoutMs: 30,
    });
    await expect(active.run(stuck, {})).rejects.toThrow(/thinking about it/);
    // Closed HERE rather than in `afterEach`, under a spy: this body never
    // settles, so it is the file's one genuinely abandoned run and `close()`
    // warns about it. Left to the shared teardown the warning would print on
    // every unit run of this package with nobody reading it.
    const warned = vi.spyOn(process, "emitWarning").mockReturnValue(undefined);
    await active.close();
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining("still running when the app closed"),
      "EvalRunAbandoned",
    );
  });
});

describe("draining a run that is still in flight", () => {
  /** A body held open by the case, which is the only way to observe one live. */
  function heldApp(): { active: EvalWorkflows; release: () => void } {
    const gate = Promise.withResolvers<void>();
    const held = workflow({
      input: z.object({}),
      run: async () => {
        await gate.promise;
        return { ok: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Held", page: "static", workflows: { held } }),
      env: {},
    });
    open = active;
    return { active, release: () => gate.resolve() };
  }

  test("`settleAll` waits for a run nothing else was waiting for", async () => {
    const { active, release } = heldApp();
    const runId = await active.client.start("held", {});
    // The state a case is in while it holds a provider response: the run is
    // live, and `run()` never saw it because a tool started it.
    expect((await active.runs())[0]?.status).toBe("running");
    release();
    const settled = await active.settleAll();
    expect(settled.map((one) => one.runId)).toEqual([runId]);
    expect(settled[0]?.completed).toBe(true);
  });

  test("a run started WHILE draining is drained too", async () => {
    let spawner: EvalWorkflows | undefined;
    const child = workflow({ input: z.object({}), run: async () => ({ child: true }) });
    const parent = workflow({
      input: z.object({}),
      run: async () => {
        await spawner?.client.start("child", {});
        return { parent: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Spawner", page: "static", workflows: { parent, child } }),
      env: {},
    });
    open = active;
    spawner = active;
    await active.client.start("parent", {});
    // The child does not exist when the walk begins, and it is exactly the run
    // a snapshot of `records()` would abandon.
    const settled = await active.settleAll();
    expect(settled.map((one) => one.workflow)).toEqual(["parent", "child"]);
  });

  test("`close()` after a drain is SILENT — the warning is about a real leak", async () => {
    const { active, release } = heldApp();
    await active.client.start("held", {});
    release();
    await active.settleAll();
    const warned = vi.spyOn(process, "emitWarning").mockReturnValue(undefined);
    await active.close();
    open = undefined;
    expect(warned).not.toHaveBeenCalled();
  });

  test("`close()` NAMES the abandoned run and what it was last doing", async () => {
    const gate = Promise.withResolvers<void>();
    const narrating = workflow({
      input: z.object({}),
      run: async () => {
        await report("halfway through");
        await gate.promise;
        return { ok: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Narrating", page: "static", workflows: { narrating } }),
      env: {},
    });
    const runId = await active.client.start("narrating", {});
    await vi.waitFor(async () => {
      expect((await active.runs())[0]?.reported).toEqual(["halfway through"]);
    });
    const warned = vi.spyOn(process, "emitWarning").mockReturnValue(undefined);
    await active.close();
    const [message] = warned.mock.calls[0] ?? [];
    expect(message).toContain(runId);
    expect(message).toContain("narrating");
    // The last progress line, because it is the only part of an abandoned run
    // that says where it got to.
    expect(message).toContain("halfway through");
    expect(message).toContain("settleAll");
    // Released so the body cannot outlive this file's other cases — the very
    // leak the warning is about.
    gate.resolve();
    await active.settleAll();
  });
});

describe("openEvalSession with a workflow client", () => {
  test("a tool that starts a run works, and the case can read what the run did", async () => {
    // The gap this closes: without the seam the runtime builds the real DevKit
    // client, whose `start` throws for a body the compiler never transformed —
    // so this tool could not run in an eval at all.
    const voice: AgentDef = {
      ...agent({ name: "Digest Line", greeting: "", workflows: { digest } }),
      tools: {
        start_digest: tool({
          description: "Start a digest run",
          inputSchema: z.object({ url: z.string() }),
          execute: async ({ url }, ctx) => ({
            runId: await ctx.workflows.start(digest, { url }, { key: "caller-1" }),
          }),
        }),
      },
    };

    const workflows = openEvalWorkflows({ agent: voice, env: {} });
    open = workflows;
    const stub = installStubLlm([
      { tool: "start_digest", args: { url: "https://example.test/post" } },
      "Started it.",
    ]);
    const session = await openEvalSession({
      agent: voice,
      workflows: workflows.client,
      llm: stub.llm,
      providerEnv: stub.env,
    });
    try {
      const turn = await session.say("digest example.test for me");
      expect(turn.toolCalls.map((call) => call.name)).toEqual(["start_digest"]);

      const runs = await workflows.runs();
      expect(runs).toHaveLength(1);
      const settled = await workflows.settle(runs[0]?.runId ?? "");
      expect(settled.status).toBe("completed");
      expect(settled.reported).toEqual(["reading https://example.test/post"]);
    } finally {
      await session.close();
      stub.release();
    }
  });
});

// Read at COLLECTION time by `describeWorkflowEval` below, which is why it is
// stubbed here rather than in a hook — the same rule `describe.test.ts` follows.
vi.stubEnv("AAI_EVAL_STUB", "1");

describeWorkflowEval(
  app,
  (test) => {
    test("drives a real run of the real body", async ({ app: opened, mode }) => {
      expect(mode).toBe("stub");
      const run = await opened.run(digest, { url: "https://example.test/x" });
      expect(run.output).toEqual({ headline: "about https://example.test/x" });
    });

    test(
      "a live-only case does not run when the providers are faked",
      async () => {
        expect.fail("a { live: true } case must be skipped in stub mode");
      },
      { live: true },
    );
  },
  { env: { ASSEMBLYAI_API_KEY: "k" } },
);

// A SECOND suite, with no `env` of its own, so the placeholder path is covered:
// a step reads its credential with `requireStepEnv`, which throws by name for a
// key nothing published — and CI's scripted run has no key at all, so without a
// placeholder every workflow template's stub gate would fail on the credential
// rather than on anything a case wrote.
describeWorkflowEval(
  agent({
    name: "Keyless App",
    page: "static",
    workflows: { keyReader },
    requiredEnv: ["A_KEY_NOBODY_HAS"],
  }),
  (test) => {
    test("fills a missing declared key with a placeholder in stub mode", async ({
      app: opened,
    }) => {
      const run = await opened.run(keyReader, {});
      expect(run.status).toBe("completed");
      // Read from inside the body through the PUBLISHED slot, so this is the
      // value `requireStepEnv` would have thrown over.
      expect(run.output).toEqual({ key: "aai-eval-stub-credential" });
    });
  },
  {},
);

describe("completedOutput", () => {
  /** The fields this reader looks at; the rest of a run is not its business. */
  const run = <R>(over: Partial<EvalWorkflowRun<R>>): EvalWorkflowRun<R> =>
    ({
      workflow: "digest",
      status: "completed",
      reported: [],
      ...over,
    }) as EvalWorkflowRun<R>;

  test("hands back the output, narrowed — no `if (output === undefined)` guard", () => {
    const output = completedOutput(run({ output: { headline: "Otters use tools" } }));
    // Narrowed to R: reading the field needs no guard, which is the whole
    // reason every case had one.
    expect(output.headline).toBe("Otters use tools");
  });

  test("a failed run throws its own REASON, not \"expected 'failed' to be 'completed'\"", () => {
    // The load-bearing ordering the copied comment was there to protect.
    expect(() => completedOutput(run({ status: "failed", error: "the page 404'd" }))).toThrow(
      /the run of "digest" failed rather than completing: the page 404'd/,
    );
  });

  test("a failed run with no message quotes its last progress line instead", () => {
    expect(() =>
      completedOutput(
        run({ status: "failed", reported: ["reading the page", "asking the model"] }),
      ),
    ).toThrow(/no reason reported \(last progress line: "asking the model"\)/);
  });

  test("a still-running run names its status rather than reading as an empty output", () => {
    expect(() => completedOutput(run({ status: "running" }))).toThrow(/"digest" running/);
  });

  test("a completed run carrying no output is its own error", () => {
    expect(() => completedOutput(run({ output: undefined }))).toThrow(/carried no output/);
  });
});
