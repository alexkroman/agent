// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval`'s `steps`: a case's scripted step HTTP, HELD on its first
 * answer and DRAINED by the harness when the case ends; `evalRunOf` over the
 * run a tool started; and the process-env placeholder a scripted case gets.
 *
 * FORCED into stub mode at module scope, read at collection time. The drain is
 * asserted from `afterAll`, since it happens after the case's body returns and
 * a second case cannot depend on the first (test order is shuffled): a run the
 * harness released and settled has COMPLETED its body by the time the suite
 * closes, and one it abandoned has not.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { stepEnv, stepFetch } from "@alexkroman1/aai/step";
import { afterAll, expect, vi } from "vitest";
import { z } from "zod";
import { STUB_ENV_VALUE } from "./_stubbed-env.ts";
import { describeEval } from "./describe.ts";
import { describeWorkflowEval } from "./describe-workflows.ts";
import { toolResultIn } from "./events.ts";
import { evalRunOf } from "./turns.ts";

vi.stubEnv("AAI_EVAL_STUB", "1");

/** Every run whose body ran to the end — what a drained run has done. */
const finished: string[] = [];

const poll = workflow({
  description: "Poll the provider once",
  input: z.object({ job: z.string() }),
  run: async (input: { job: string }) => {
    const res = await stepFetch(`https://provider.test/jobs/${input.job}`);
    const body = (await res.json()) as { status: string };
    finished.push(input.job);
    return { status: body.status };
  },
});

const startJob = tool({
  description: "Start a poll.",
  inputSchema: z.object({ job: z.string() }),
  execute: async ({ job }, ctx) => ({ runId: await ctx.workflows.start(poll, { job }) }),
});

const def = withTools(agent({ name: "Steps Suite", workflows: { poll } }), {
  start_job: startJob,
});

const START = { stubReply: [{ tool: "start_job", args: { job: "j1" } }, "Started."] };

afterAll(() => {
  // A throw rather than an `expect`: a hook is not a test. Each held case
  // below returned with its run parked; the harness released and settled it.
  if (!finished.includes("j1")) {
    throw new Error(`the harness did not drain the held run; finished: ${finished.join(", ")}`);
  }
});

describeEval(
  def,
  (test) => {
    test(
      "the first answer is held, so the run is observably in flight; the harness drains it",
      async ({ session, workflows, steps }) => {
        const turn = await session.say("start the job");
        const runId = evalRunOf(turn, poll);
        // The same id the tool answered the model with — read off the client,
        // not parsed out of the result.
        expect(toolResultIn(turn.toolCalls, startJob)).toEqual({ runId });
        await vi.waitFor(() => expect(steps?.held).toBe(true));
        expect(steps?.requests.map((request) => request.pathname)).toEqual(["/jobs/j1"]);
        const runs = await (workflows?.runs() ?? []);
        expect(runs.map((run) => [run.runId, run.status])).toEqual([[runId, "running"]]);
        // Returned WITHOUT releasing: `afterAll` holds the harness to the drain.
      },
      START,
    );

    test(
      "by name, too, and a workflow the turn did not start throws naming what it did",
      async ({ session }) => {
        const turn = await session.say("start the job");
        expect(evalRunOf(turn, "poll")).toBe(evalRunOf(turn, poll));
        expect(() => evalRunOf(turn, "digest")).toThrow(
          /no run of "digest" was started in this turn; it started poll \(/,
        );
      },
      START,
    );
  },
  {
    steps: {
      routes: { "https://provider.test/jobs/": { body: { status: "completed" } } },
      hold: "first",
    },
  },
);

const readKey = tool({
  description: "Read a declared key outside any run.",
  execute: () => ({ key: stepEnv("A_KEY_NOBODY_HAS") }),
});

describeEval(
  withTools(agent({ name: "Keyless Tool Suite", requiredEnv: ["A_KEY_NOBODY_HAS"] }), {
    read_key: readKey,
  }),
  (test) => {
    test(
      "a declared key nobody has is a placeholder in the PROCESS env, for a tool outside a run",
      async ({ session }) => {
        const turn = await session.say("read it");
        expect(toolResultIn(turn.toolCalls, readKey)).toEqual({ key: STUB_ENV_VALUE });
      },
      { stubReply: [{ tool: "read_key" }, "Read."] },
    );
  },
);

describeWorkflowEval(
  agent({ name: "Steps App", mode: "workflow-app", workflows: { poll } }),
  (test) => {
    test("a workflow suite's steps are held and drained the same way", async ({ app, steps }) => {
      const started = app.run(poll, { job: "j2" });
      await vi.waitFor(() => expect(steps?.held).toBe(true));
      steps?.release();
      expect((await started).output).toEqual({ status: "completed" });
    });
  },
  {
    steps: {
      routes: { "https://provider.test/jobs/": { body: { status: "completed" } } },
      hold: "first",
    },
  },
);
