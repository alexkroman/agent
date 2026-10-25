// An EVAL: does this desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives the tools against a STUBBED `ctx.workflows`, the steps
// against a stubbed provider, and the body on the replay engine. What none of
// those tiers can say is whether the AGENT — a model, reading this system
// prompt, holding these tools — hands a recording off at all, whether the run
// it starts is the same run a later turn finds, and whether a caller who says
// "forget it" is told the truth about what cancelling does. That is what this
// file is for: `describeEval` opens a real workflow engine per case and hands
// its client to the session.
//
// Three boundaries, each of which a case here would be dishonest to imply:
//
//   * **The engine is not durable.** A `sleep()` is RECORDED rather than taken,
//     and a timed `waitFor` resolves `undefined` at once — so the poll below
//     runs at full speed, and the only way to observe a run in flight is to
//     hold the provider's first status answer, which the suite's `steps` does.
//   * **Nobody can answer a hook here**, so the RETENTION GATE — this
//     template's headline port of Temporal's `expense` — is reached through
//     exactly ONE of its three branches: the closed window. Every run that gets
//     past `summarize` takes the safe default, deletes the transcript it made,
//     and completes; that branch is asserted below. The two ANSWERED branches
//     are `agent.test.ts`'s, against `askWhetherToKeep` and on the replay
//     engine.
//   * **Every run takes the NO-CALLBACK arm.** Nothing publishes a webhook
//     minter here, so the job is submitted with no `webhook_url` — asserted
//     POSITIVELY below — and the callback window closes at once.
//
// The provider is scripted in BOTH modes, so the transcription, the recap's
// model call and the compensating DELETE are deterministic and free, while the
// SESSION's model stays live.

import agentDef from "virtual:aai/agent";
import type { FetchRouteHandler, FetchRouteRequest } from "@alexkroman1/aai-runtime/testing";
import {
  describeEval,
  type EvalSteps,
  type EvalToolCall,
  evalRunOf,
  stubGatewayRoute,
  toolResultIn,
  toolResultsIn,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { z } from "zod";
import recap, { SAMPLE_RECORDING } from "./workflows/recap.ts";

/** The job id the scripted provider mints for every submission. */
const TRANSCRIPT_ID = "t_eval_1";

/** What the scripted transcript says, once it completes. */
const TRANSCRIPT_TEXT =
  "Smoke from the Canadian wildfires reached the eastern seaboard overnight, " +
  "and air quality indexes went into the unhealthy range.";

/** The recap the scripted model writes. `spoken` is the field the phone reads. */
const RECAP_JSON = JSON.stringify({
  headline: "Wildfire smoke reaches the east coast",
  points: ["Smoke crossed overnight", "Air quality is unhealthy", "Advisories are in force"],
  spoken: "Wildfire smoke drifted east overnight and pushed air quality into the unhealthy range.",
});

/**
 * How this case's provider behaves: whether to HOLD the first status read, and
 * how the job ends. Set per case; read by the suite-level routes.
 */
const scenario = { hold: true, ending: "completed" as "completed" | "error" };

function script(options: Partial<typeof scenario>): void {
  Object.assign(scenario, { hold: true, ending: "completed" }, options);
}

/** AssemblyAI's batch API, answered in memory. One reply, so the gateway is shared. */
const model = stubGatewayRoute(RECAP_JSON);
const provider: FetchRouteHandler = (request) => {
  if (request.method === "POST") return { body: { id: TRANSCRIPT_ID, status: "queued" } };
  // The compensation. A real DELETE removes the transcript from the account,
  // which is what makes "a failed run leaves nothing behind" a claim rather
  // than a comment — so the assertion that matters is that this was CALLED.
  if (request.method === "DELETE") return { body: {} };
  if (request.method !== "GET") return;
  return scenario.ending === "error"
    ? { body: { status: "error", error: "that recording could not be decoded" } }
    : { body: { status: "completed", text: TRANSCRIPT_TEXT, audio_duration: 254 } };
};

/** `request_recap`'s two answers — it started one, or it found the live one. */
const RecapStart = z.union([
  z.object({ started: z.literal(true), runId: z.string().min(1) }),
  z.object({ started: z.literal(false), runId: z.string().min(1), note: z.string() }),
]);

/** `workflow_cancel`'s answer. */
const Cancelled = z.object({ cancelled: z.boolean(), note: z.string() });

/** Every tool call in this turn that READS a run, whichever the model picked. */
function readbacks(calls: readonly EvalToolCall[]): readonly EvalToolCall[] {
  return calls.filter((one) => one.name === "workflow_status" || one.name === "workflow_progress");
}

/** Requests of one method the run has made so far, held ones included. */
function requests(steps: EvalSteps | undefined, method: string): readonly FetchRouteRequest[] {
  return (steps?.requests ?? []).filter((one) => one.method === method);
}

/** `text` as a regex that matches only itself. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one utterance every case that starts work opens with. */
const ASK = "Can you write up that recording for me?";

/** The scripted session turn that answers {@link ASK}. */
const START_TURN = [
  { tool: "request_recap", args: {} },
  "I've started writing that up — I'll let you know when it lands.",
] as const;

describeEval(
  agentDef,
  (test) => {
    test(
      "starts one run for the caller and will not pay for a second",
      async ({ session, workflows, steps }) => {
        // Held, so the first run is unambiguously still live when the caller
        // asks again — which is the state the live-run check exists for.
        script({ hold: true });

        const first = await session.say(ASK);
        const runId = evalRunOf(first, recap);
        const again = await session.say("Actually, start it again from scratch, please.");

        // Temporal's workflow-id reuse policy: a caller who asks twice is told
        // about the run they already have. WHETHER the model calls the tool a
        // second time is its business — it may simply remember — so each call it
        // did make has to have been refused with the run it found.
        for (const answer of toolResultsIn(again.toolCalls, "request_recap", RecapStart)) {
          expect(answer.started).toBe(false);
          expect(answer.runId).toBe(runId);
        }

        // ONE run, and ONE submission to the provider.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.map((one) => one.runId)).toEqual([runId]);
        expect(runs[0]?.workflow).toBe("recap");
        const posts = requests(steps, "POST");
        expect(posts).toHaveLength(1);
        // It submitted the recording the DESK supplies, because a phone caller
        // cannot read a URL aloud — and with NO `webhook_url`, asserted
        // positively: see the third boundary in this file's header.
        expect(posts[0]?.json).toMatchObject({ audio_url: SAMPLE_RECORDING, speaker_labels: true });
        expect(Object.keys(posts[0]?.json as object)).not.toContain("webhook_url");
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "request_recap", args: {} },
          "There's already one running for you — I'll tell you as soon as it lands.",
        ],
      },
    );

    test(
      "reads the live run back rather than guessing at it",
      async ({ session, workflows, steps }) => {
        script({ hold: true });

        const started = await session.say(ASK);
        const runId = evalRunOf(started, recap);
        const turn = await session.say("How's that going?");

        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        const answered = read.map((one) => one.result ?? "").join("\n");

        // The load-bearing half: that readback happened while the run really
        // was in flight, waiting on the provider.
        const runs = await (workflows?.runs() ?? []);
        const live = runs.find((one) => one.runId === runId);
        expect(live?.status).toBe("running");
        expect(requests(steps, "GET")).toHaveLength(1);

        // WHICH readback builtin the model picks is its business, so the claim
        // is about what it was TOLD: `workflow_progress` hands back the run's
        // own latest line and `workflow_status` the desk's status line.
        const lastLine = String(live?.reported.at(-1));
        expect(live?.reported.length).toBeGreaterThan(0);
        expect(answered).toMatch(new RegExp(`${literal(lastLine)}|Still working on that one`));
        expect(answered).not.toMatch(/Nothing has been started/);
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "workflow_progress", args: {} },
          "It's with the transcription service now — nothing back yet.",
        ],
      },
    );

    test(
      "cancelling says plainly what it did NOT roll back, and really does not",
      async ({ session, workflows, steps }) => {
        script({ hold: true });

        const started = await session.say(ASK);
        const runId = evalRunOf(started, recap);
        const turn = await session.say("Forget it — cancel that, please.");

        const answer = toolResultIn(turn.toolCalls, "workflow_cancel", Cancelled);
        expect(answer.cancelled).toBe(true);
        // The sentence is the declaration's `cancelNote`, and a documented
        // promise of this template: cancellation is NOT cooperative here.
        expect(answer.note).toMatch(/left behind/);
        expect(answer.note).toMatch(/does not roll back/);

        // And it is TRUE, which is the part only an eval with a real run can
        // check: the run is cancelled, and no compensating DELETE went out.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.find((one) => one.runId === runId)?.status).toBe("cancelled");
        expect(requests(steps, "DELETE")).toEqual([]);
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "workflow_cancel", args: {} },
          "Stopped it. The partial transcript stays on file — cancelling doesn't undo that.",
        ],
      },
    );

    test("nobody answers the retention gate, so the transcript is not kept", async ({
      workflows,
      steps,
    }) => {
      // The gate's SAFE DEFAULT, and the branch this tier really does reach —
      // worth an assertion of its own: a gate whose no-answer branch KEPT the
      // data would be a prompt with a grace period.
      script({ hold: false });

      const run = await workflows?.run(recap, {
        url: SAMPLE_RECORDING,
        requestedBy: "eval-session",
      });

      expect(run?.status).toBe("completed");
      // `answered: false` separates this from a caller who said no.
      expect(run?.output).toMatchObject({ kept: false, answered: false });
      // And the default really is DELETE — the same request the compensation
      // makes, reached by the opposite path: this run succeeded.
      expect(requests(steps, "DELETE").map((one) => one.url)).toEqual([
        `https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`,
      ]);
      // The caller was ASKED first, which is what makes silence an answer.
      expect(run?.reported.join("\n")).toMatch(/Keep the transcript on file/);
    });

    test("a run that fails after creating a transcript deletes it again", async ({
      workflows,
      steps,
    }) => {
      // Started from the CASE, because the subject is the saga and the failure
      // has to be injected: the provider refuses the job, which is the branch
      // that unwinds the compensation stack.
      script({ hold: false, ending: "error" });

      const run = await workflows?.run(recap, {
        url: SAMPLE_RECORDING,
        requestedBy: "eval-session",
      });

      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/could not transcribe/);
      const narration = run?.reported.join("\n") ?? "";
      expect(narration).toMatch(/undoing 1 step/);
      expect(narration).toMatch(`Discarding transcript ${TRANSCRIPT_ID}.`);
      // The transcript this run created was deleted from the account: an undo
      // registered BEFORE its step, or a `catch` that stopped compensating,
      // fails here.
      expect(requests(steps, "DELETE").map((one) => one.url)).toEqual([
        `https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`,
      ]);
    });
  },
  // The STEP fetch only — the model leg first, on the completions path, then
  // the provider — with the first status read HELD while a case says so.
  {
    steps: {
      routes: [model.route, provider],
      hold: (request) => scenario.hold && request.method === "GET",
    },
  },
);
