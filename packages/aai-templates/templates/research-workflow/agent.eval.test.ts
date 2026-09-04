// An EVAL: does this desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives the four tools against a STUBBED `ctx.workflows` and
// the five steps against a stubbed `fetch`. Neither can say whether the AGENT —
// a model, reading this system prompt, holding these four tools — hands the
// work off at all, or whether the run it starts is findable afterwards. That is
// what this file is for, and it is only possible because `describeEval` opens a
// real workflow engine per case and hands its client to the session: before
// that, a tool calling `ctx.workflows.start` was a tool an eval could not
// execute.
//
// Two boundaries this file is careful about, because a case that implied either
// would be the worse failure:
//
//   * **The engine is not durable.** No journal, no replay, no retry, and a
//     `sleep()` is RECORDED rather than taken (which is why the review wait
//     below is an assertion about what the body ASKED for). Nothing here says
//     anything about resume, and `aai-cli`'s `dev-workflow.scenario.test.ts` is
//     the tier that does.
//   * **A step's HTTP is scripted, in BOTH modes.** The live half of an eval is
//     the SESSION's model — which tool the desk reaches for, and when. The
//     run's own five-to-twelve model calls and its web searches are answered
//     from `MODEL_SCRIPT` through the published `stepFetch` slot, so a case is
//     deterministic, free, and cannot fail on a DuckDuckGo 403 or a rate limit
//     the engine's inert `maxRetries` could not ride out. What the researcher's
//     search loop does with what it finds is `agent.test.ts`'s subject.
//
// And what no eval here can see at all: anything below the audio boundary —
// endpointing, barge-in, whether two sentences merged into one turn.

import agentDef from "virtual:aai/agent";
import { routeStepFetch, stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import { type EvalToolCall, type EvalWorkflows, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { research } from "./shared.ts";
/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * Load-bearing, and not applied by `agent()` — the BUILD is what enumerates
 * `tools/`, so an eval driving the raw default export would measure a desk with
 * no tools at all and every assertion below would mean nothing. This template
 * declares its prompt inline in `agent.ts`, so there is no `system-prompt.md`
 * to layer on with `withSystemPrompt`.
 *
 * The glob is written here rather than reached for from a shared helper because
 * this file SHIPS — see `agent.test.ts`.
 */
import { REVIEW_DELAY_MS } from "./workflows/research.ts";

/**
 * The key the run's steps read with `requireStepEnv`.
 *
 * Passed as the agent env so the eval's workflow engine publishes it: the
 * gateway call below is answered by a fake, but `stepGenerate` asks for the key
 * BEFORE it makes the request, so a run with no key fails on the missing
 * credential rather than reaching the script. The ENVIRONMENT and nothing else —
 * a template may not read a developer's CLI config.
 */
const EVAL_ENV = { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "eval-scripted-key" };

/** The one angle the scripted planner comes back with. */
const ANGLE = "What second-hand cargo bikes actually sell for";

/** The written report the scripted `writeReport` produces. */
const REPORT_BODY =
  "## Second-hand cargo bikes in Amsterdam\n\nAsking prices cluster between 1,200 and 2,400 EUR.";

/** The two sentences the desk reads down the phone. */
const SPOKEN_SUMMARY =
  "Second-hand cargo bikes in Amsterdam mostly go for between one and two and a half thousand euros.";

/**
 * What the run's model calls are answered with, in the order the body asks.
 *
 * Six calls, and the ORDER is the assertion: brief, angles, the researcher's
 * one action, the gap pass, the report, the spoken summary. A stage that
 * disappeared or moved would hand a later stage an earlier reply, which is
 * exactly what the two content assertions in "writes the report" catch.
 *
 * The researcher's action is `stop` on purpose: `search` and `read` go through
 * `webSearch`/`visitWebpage`, whose fetch is the global one and not the step
 * slot, so scripting them is not available here — a case that let them run
 * would really search the web.
 */
const MODEL_SCRIPT: readonly string[] = [
  JSON.stringify({
    brief: "What a used cargo bike costs in Amsterdam, and where they are sold.",
    criteria: ["typical asking prices", "where people buy them"],
  }),
  JSON.stringify({ angles: [ANGLE] }),
  JSON.stringify({ action: "stop", why: "the budget is better spent elsewhere" }),
  JSON.stringify({ angles: [] }),
  REPORT_BODY,
  SPOKEN_SUMMARY,
];

/** A scripted step HTTP surface, and the gate that holds its first answer. */
type ScriptedSteps = {
  /** Every step request, in order — the gateway calls the run really made. */
  readonly calls: readonly { url: string; method: string }[];
  /** Let a held first answer through. Idempotent. */
  readonly release: () => void;
};

/**
 * Answer the run's model calls from {@link MODEL_SCRIPT}.
 *
 * Through `stepFetch`'s published slot rather than `vi.stubGlobal("fetch")`,
 * which is what a step really dials — and which leaves the SESSION's own model
 * on the live path, so a live case still measures the agent. Anything that is
 * not the gateway THROWS rather than answering 200: an unexpected request from
 * a step is a finding, and a silent empty body would be read as a model that
 * said nothing. `stubGatewayRoute` is what decides which is which, and it
 * decides on the SDK's own completions PATH — so the script cannot come unstuck
 * from the step by the two agreeing on a typo, and the envelope it answers with
 * is the SDK's rather than this file's. That last part is the one worth having:
 * the envelope is a WIRE shape, so a field typed one off does not fail —
 * `stepGenerate` reads no content, reports an empty completion, and the case
 * blames the run.
 *
 * The CURSOR is the reader's too: the last reply repeats, which is what a stage
 * that legitimately calls the model twice needs and what stops a script running
 * out mid-run and failing on itself.
 *
 * `hold` keeps the FIRST answer pending, which is the only way to observe a run
 * that is still going: a durable `sleep` is skipped here, so an unheld run
 * finishes in milliseconds.
 */
function scriptSteps(options: { hold?: boolean } = {}): ScriptedSteps {
  const gate = Promise.withResolvers<void>();
  const model = stubGatewayRoute(MODEL_SCRIPT);
  // Throwing on an unrecognised request is `routeStepFetch`'s default and is
  // what this file wants: every step here is a model call.
  const route = routeStepFetch([model.route]);
  const stub = installStubStepFetch(async (request) => {
    const answered = route(request);
    // `model.calls` has already recorded this one, so a length of 1 IS the first
    // answer — and holding after the route rather than before it keeps the reply
    // this returns the one the script owed that call.
    if (options.hold === true && model.calls.length === 1) await gate.promise;
    return answered;
  });
  return { calls: stub.calls, release: () => gate.resolve() };
}

/** `request_research`'s answer when it really started something. */
const Started = z.object({
  started: z.literal(true),
  runId: z.string().min(1),
  topic: z.string().min(1),
});

/**
 * The run id the `request_research` call reported.
 *
 * `toolResultIn` rather than a `find` and a parse: a tool result reaches the
 * event stream as a serialized string, and a shape that stopped matching should
 * fail HERE naming the field instead of handing the next assertion `undefined`.
 * It throws for the two other ways this can go wrong as well, each naming what
 * was really called — no such call, and a call that never returned.
 */
function startedRunId(calls: readonly EvalToolCall[]): string {
  return toolResultIn(calls, "request_research", Started).runId;
}

/** Every tool call in this turn that READS a run, whichever the model picked. */
function readbacks(calls: readonly EvalToolCall[]): readonly EvalToolCall[] {
  return calls.filter((one) => one.name === "research_status" || one.name === "research_progress");
}

/** The one utterance every case that starts work opens with. */
const ASK = "Please research the second-hand cargo bike market in Amsterdam for me.";

/** The scripted session turn that answers {@link ASK}. */
const START_TURN = [
  { tool: "request_research", args: { topic: "the second-hand cargo bike market in Amsterdam" } },
  "I've started looking into that — I'll let you know when it lands.",
] as const;

/**
 * Let the run finish before the case ends.
 *
 * Not tidiness: the scripted `stepFetch` is unpublished when the test that
 * installed it finishes, so a body still mid-flight would make its next model
 * call against whatever the next case publishes — or against the real gateway.
 * `close()` reports that on stderr (`EvalRunAbandoned`) rather than fixing it:
 * the wait is `settleAll`'s, and the RELEASE stays here, because what holds the
 * run in flight is this file's own gate and nothing in the harness can open one.
 */
async function drain(workflows: EvalWorkflows | undefined, steps: ScriptedSteps): Promise<void> {
  steps.release();
  await workflows?.settleAll();
}

describeEval(
  agentDef,
  (test) => {
    test(
      "hands the topic to a run and answers the turn without waiting for it",
      async ({ session, workflows }) => {
        // Held, so the run cannot possibly have finished by the time the desk
        // replies — which is the whole claim of the handoff shape.
        const steps = scriptSteps({ hold: true });

        const turn = await session.say(ASK);

        const runId = startedRunId(turn.toolCalls);
        expect(turn.completed).toBe(true);
        // The topic it passed is the caller's, not a paraphrase of the prompt.
        const asked = turn.toolCalls.find((one) => one.name === "request_research");
        expect(String(asked?.args.topic)).toMatch(/cargo bike/i);

        // The run is REAL: the engine started it, under the name the agent
        // declares, and it is still going now that the turn has ended.
        const runs = await (workflows?.runs() ?? []);
        const started = runs.find((one) => one.runId === runId);
        expect(started?.workflow).toBe("research");
        expect(started?.status).toBe("running");
        // And it really began work — the brief stage narrated before its model
        // call, which is the request this case is holding.
        expect(started?.reported.join("\n")).toMatch(/really asking/);

        await drain(workflows, steps);
      },
      { stubReply: [...START_TURN] },
    );

    test(
      "the run really writes the report, and asks for the review wait",
      async ({ session, workflows }) => {
        const steps = scriptSteps();

        const turn = await session.say(ASK);
        const runId = startedRunId(turn.toolCalls);
        const run = await workflows?.settle(runId, research);

        // What a completed run reports as `output` is what the agent reads back
        // and what the announcement is built from, so every field is asserted.
        expect(run?.status).toBe("completed");
        expect(run?.output?.report).toBe(REPORT_BODY);
        expect(run?.output?.summary).toBe(SPOKEN_SUMMARY);
        expect(run?.output?.angles).toEqual([ANGLE]);
        expect(run?.output?.filedAt).toBe("filed");

        // The five stages, in order, off the run's own narration — which is
        // also what `research_progress` reads back down the phone. A stage that
        // stopped reporting is a caller who is told nothing for minutes.
        const narration = run?.reported.join("\n") ?? "";
        expect(narration).toMatch(/really asking/);
        expect(narration).toMatch(/Researching 1 angle/);
        expect(narration).toMatch(new RegExp(`Looking into: ${ANGLE}`));
        expect(narration).toMatch(/writing it up/);
        expect(narration).toMatch(/Writing up 1 angle/);
        expect(run?.reported.at(-1)).toBe("Filing the findings.");

        // The review wait, ASKED FOR and not taken: this engine records a
        // durable `sleep` rather than suspending, so what a case can honestly
        // claim is that the body asked — and that is the assertion that fails
        // if the suspension is ever deleted.
        expect(run?.slept).toEqual([{ label: "reviewWindow", duration: REVIEW_DELAY_MS }]);

        // Six model calls, all through the step slot: the fan-out's width came
        // from a journaled stage rather than from anything the body recomputed.
        expect(steps.calls).toHaveLength(MODEL_SCRIPT.length);
      },
      { stubReply: [...START_TURN] },
    );

    test(
      "reads the live run back rather than guessing at it",
      async ({ session, workflows }) => {
        const steps = scriptSteps({ hold: true });

        const started = await session.say(ASK);
        const runId = startedRunId(started.toolCalls);
        const turn = await session.say("What's it doing right now?");

        // WHICH of the two readback tools the model picks is its business —
        // the prompt offers both — so the claim is about what it was told:
        // either the run's own latest progress line or its status, and never
        // an answer the desk invented.
        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        const answered = read.map((one) => one.result ?? "").join("\n");
        expect(answered).toMatch(/really asking|Still working on it/);
        expect(answered).not.toMatch(/Nothing started yet/);

        // The load-bearing half: that readback happened while the run was
        // genuinely in flight, which is the only state these two tools exist
        // for.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.find((one) => one.runId === runId)?.status).toBe("running");

        await drain(workflows, steps);
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "research_progress", args: {} },
          "It's still working out what the question really is.",
        ],
      },
    );

    test(
      "says nothing is running when nothing is, and starts nothing to find out",
      async ({ session, workflows }) => {
        const steps = scriptSteps();

        const turn = await session.say("Any news on that research I asked for?");

        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        expect(read.map((one) => one.result ?? "").join("\n")).toMatch(/Nothing started yet/);
        // A question is not a request: asking after work nobody asked for must
        // not put a run — and a research pass's worth of model calls — on the
        // account.
        expect(await (workflows?.runs() ?? [])).toEqual([]);
        expect(steps.calls).toEqual([]);
      },
      {
        stubReply: [
          { tool: "research_status", args: {} },
          "Nothing has been started yet — want me to look into something?",
        ],
      },
    );
  },
  { env: EVAL_ENV },
);
