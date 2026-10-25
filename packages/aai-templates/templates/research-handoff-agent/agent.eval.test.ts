// An EVAL: does this desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives the tools against a STUBBED `ctx.workflows` and the
// run against a stubbed gateway. Neither can say whether the AGENT — a model,
// reading this system prompt, holding these tools — hands the work off at all,
// or whether the run it starts is findable afterwards. That is what this file
// is for: `describeEval` opens a real workflow engine per case and hands its
// client to the session.
//
// Two boundaries: the engine is not durable (a `sleep()` is RECORDED, not
// taken, so the review wait is an assertion about what the body ASKED for),
// and a step's HTTP is scripted in BOTH modes through `steps` — the run's own
// model calls are answered from `MODEL_SCRIPT`, so a case is deterministic and
// free while the SESSION's model stays live.

import agentDef from "virtual:aai/agent";
import {
  describeEval,
  type EvalToolCall,
  evalRunOf,
  installStubStepDelegate,
  type StubGatewayRoute,
  stubGatewayRoute,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import research, { REVIEW_DELAY_MS } from "./workflows/research.ts";

/** The one angle the scripted planner comes back with. */
const ANGLE = "What second-hand cargo bikes actually sell for";

/** What the scripted researcher concluded — the subagent's final message. */
const RESEARCH_FINDINGS =
  "Used cargo bikes in Amsterdam ask 800-2500 EUR depending on age and " +
  "electric assist, mostly on Marktplaats and at two second-hand dealers.";

/** The written report the scripted `writeReport` produces. */
const REPORT_BODY =
  "## Second-hand cargo bikes in Amsterdam\n\nAsking prices cluster between 1,200 and 2,400 EUR.";

/** The two sentences the desk reads down the phone. */
const SPOKEN_SUMMARY =
  "Second-hand cargo bikes in Amsterdam mostly go for between one and two and a half thousand euros.";

/**
 * What the run's model calls are answered with, in the order the body asks:
 * brief, angles, the gap pass, the report, the spoken summary. The researcher's
 * own loop goes through the DELEGATE slot, not the gateway.
 */
const MODEL_SCRIPT: readonly string[] = [
  JSON.stringify({
    brief: "What a used cargo bike costs in Amsterdam, and where they are sold.",
    criteria: ["typical asking prices", "where people buy them"],
  }),
  JSON.stringify({ angles: [ANGLE] }),
  JSON.stringify({ angles: [] }),
  REPORT_BODY,
  SPOKEN_SUMMARY,
];

/** The gateway, re-scripted per case: its cursor is the case's, not the suite's. */
let model: StubGatewayRoute = stubGatewayRoute(MODEL_SCRIPT);

/** A fresh script for this case, and the researcher that answers off-gateway. */
function scriptSteps(): StubGatewayRoute {
  model = stubGatewayRoute(MODEL_SCRIPT);
  installStubStepDelegate({ routes: { researcher: RESEARCH_FINDINGS } });
  return model;
}

/** Every tool call in this turn that READS a run, whichever the model picked. */
function readbacks(calls: readonly EvalToolCall[]): readonly EvalToolCall[] {
  return calls.filter((one) => one.name === "workflow_status" || one.name === "workflow_progress");
}

/** The one utterance every case that starts work opens with. */
const ASK = "Please research the second-hand cargo bike market in Amsterdam for me.";

/** The scripted session turn that answers {@link ASK}. */
const START_TURN = [
  { tool: "request_research", args: { topic: "the second-hand cargo bike market in Amsterdam" } },
  "I've started looking into that — I'll let you know when it lands.",
] as const;

describeEval(
  agentDef,
  (test) => {
    test(
      "hands the topic to a run and answers the turn without waiting for it",
      async ({ session, workflows }) => {
        // The first gateway answer is HELD by the suite's `steps`, so the run
        // cannot possibly have finished by the time the desk replies — which is
        // the whole claim of the handoff shape.
        scriptSteps();

        const turn = await session.say(ASK);

        const runId = evalRunOf(turn, research);
        expect(turn.completed).toBe(true);
        // The topic it passed is the caller's, not a paraphrase of the prompt.
        const asked = turn.toolCalls.find((one) => one.name === "request_research");
        expect(String(asked?.args.topic)).toMatch(/cargo bike/i);

        // The run is REAL: the engine started it, under the name the file
        // declares, and it is still going now that the turn has ended.
        const runs = await (workflows?.runs() ?? []);
        const started = runs.find((one) => one.runId === runId);
        expect(started?.workflow).toBe("research");
        expect(started?.status).toBe("running");
        // And it really began work — the brief stage narrated before its model
        // call, which is the request being held.
        expect(started?.reported.join("\n")).toMatch(/really asking/);
      },
      { stubReply: [...START_TURN] },
    );

    test(
      "the run really writes the report, and asks for the review wait",
      async ({ session, workflows, steps }) => {
        const model = scriptSteps();
        // Nothing to observe mid-flight here, so let the run go.
        steps?.release();

        const turn = await session.say(ASK);
        const run = await workflows?.settle(evalRunOf(turn, research), research);

        // What a completed run reports as `output` is what the agent reads back
        // and what the announcement is built from, so every field is asserted.
        expect(run?.status).toBe("completed");
        expect(run?.output?.report).toBe(REPORT_BODY);
        expect(run?.output?.summary).toBe(SPOKEN_SUMMARY);
        expect(run?.output?.angles).toEqual([ANGLE]);
        // A real timestamp: the filing step answers with when it filed.
        expect(Number.isNaN(Date.parse(run?.output?.filedAt ?? ""))).toBe(false);

        // The stages, in order, off the run's own narration — which is also
        // what `workflow_progress` reads back down the phone.
        const narration = run?.reported.join("\n") ?? "";
        expect(narration).toMatch(/really asking/);
        expect(narration).toMatch(/Researching 1 angle/);
        expect(narration).toMatch(new RegExp(`Looking into: ${ANGLE}`));
        expect(narration).toMatch(/writing it up/);
        expect(narration).toMatch(/Writing up 1 angle/);
        // No `RESEARCH_SLACK_WEBHOOK_URL` in an eval, so the last line is the
        // arm that says the report stayed on the run.
        expect(run?.reported.at(-1)).toMatch(/^Filing the findings/);

        // The review wait, ASKED FOR and not taken: this engine records a
        // durable `sleep` rather than suspending.
        expect(run?.slept).toEqual([{ label: "reviewWindow", duration: REVIEW_DELAY_MS }]);

        // Every model call went through the step slot, and the fan-out's width
        // came from a journaled stage rather than anything the body recomputed.
        expect(model.calls).toHaveLength(MODEL_SCRIPT.length);
      },
      { stubReply: [...START_TURN] },
    );

    test(
      "reads the live run back rather than guessing at it",
      async ({ session, workflows }) => {
        scriptSteps();

        const started = await session.say(ASK);
        const runId = evalRunOf(started, research);
        const turn = await session.say("What's it doing right now?");

        // WHICH of the two readback builtins the model picks is its business —
        // so the claim is about what it was told: either the run's own latest
        // progress line or its status line, and never an answer the desk
        // invented.
        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        const answered = read.map((one) => one.result ?? "").join("\n");
        expect(answered).toMatch(/really asking|still working on it/);
        expect(answered).not.toMatch(/Nothing has been started/);

        // The load-bearing half: that readback happened while the run was
        // genuinely in flight.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.find((one) => one.runId === runId)?.status).toBe("running");
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "workflow_progress", args: {} },
          "It's still working out what the question really is.",
        ],
      },
    );

    test(
      "says nothing is running when nothing is, and starts nothing to find out",
      async ({ session, workflows, steps }) => {
        scriptSteps();

        const turn = await session.say("Any news on that research I asked for?");

        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        expect(read.map((one) => one.result ?? "").join("\n")).toMatch(/Nothing has been started/);
        // A question is not a request: asking after work nobody asked for must
        // not put a run — and a research pass's worth of model calls — on the
        // account.
        expect(await (workflows?.runs() ?? [])).toEqual([]);
        expect(steps?.requests).toEqual([]);
      },
      {
        stubReply: [
          { tool: "workflow_status", args: {} },
          "Nothing has been started yet — want me to look into something?",
        ],
      },
    );
  },
  // The run's model calls, scripted on the STEP fetch only, with the first
  // answer held until the case releases it (or ends): a durable `sleep` is
  // skipped here, so an unheld run finishes in milliseconds.
  { steps: { routes: [(request) => model.route(request)], hold: "first" } },
);
