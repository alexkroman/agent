// An EVAL: does this desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives the five tools against a STUBBED `ctx.workflows`, the
// steps against a stubbed provider, and the body's two helpers with `sleep` and
// `createHook` mocked. What none of those tiers can say is whether the AGENT —
// a model, reading this system prompt, holding these five tools — hands a
// recording off at all, whether the run it starts is the same run a later turn
// finds, and whether a caller who says "forget it" is told the truth about what
// cancelling does. That is what this file is for, and it is only possible
// because `describeEval` opens a real workflow engine per case and hands its
// client to the session.
//
// Three boundaries, each of which a case here would be dishonest to imply:
//
//   * **The engine is not durable.** No journal, no replay, no retry, and a
//     `sleep()` is RECORDED rather than taken — so the poll loop below runs at
//     full speed and the only way to observe a run in flight is to hold the
//     provider's answer, which is what `hold` does.
//   * **Nobody can answer a hook here**, which reaches the RETENTION GATE — this
//     template's headline port of Temporal's `expense` — through exactly ONE of
//     its three branches. `ctx.waitFor` carrying a `timeoutMs` resolves
//     `undefined` in this engine, which IS the closed window, so every run that
//     gets past `summarize` takes the gate's safe default: it deletes the
//     transcript it made and completes. That branch is asserted below. The two
//     ANSWERED branches are the unreachable ones — `signal()` answers `false`
//     for every token, there being nothing in process to deliver a payload — so
//     an approval, a decline and `keep_transcript` itself are `agent.test.ts`'s
//     to drive against `askWhetherToKeep`, and it is the only tier that can.
//   * **Every run here takes the NO-CALLBACK arm, and that must not be read as
//     coverage of the webhook path.** The eval publishes no webhook minter, so
//     `stepWebhookUrl` throws, the template's `callbackUrl` degrades to
//     `undefined`, the job is submitted with no `webhook_url`, and
//     `awaitTranscript` never parks on a hook at all — it polls, exactly as it
//     did before the provider could call back. That is worth having rather than
//     working around: it is the arm a deployment with no public URL takes, it is
//     the arm a dropped delivery lands on, and it is the one that must never
//     hang. A case below asserts it POSITIVELY — that the submitted job carries
//     no `webhook_url` — so an eval runtime that later publishes a minter fails
//     here instead of silently changing what all of these cases measure.
//
//     What no eval here can show is a delivery RESUMING a run, so no case claims
//     it. The answered arm is `agent.test.ts`'s, through
//     `createWorkflowCtx({ hooks })`, which is the only tier that can send a
//     payload at all; a real HTTP POST to the public callback route is
//     `aai-cli`'s `dev-workflow.scenario.test.ts`'s, and is not yet written.
//   * **The provider is scripted, in BOTH modes**, through `stepFetch`'s
//     published slot — so the transcription, the recap's model call and the
//     compensating DELETE are all deterministic and free, while the SESSION's
//     model stays live and is what a live run measures.
//
// And what no eval here can see: anything below the audio boundary.

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * Load-bearing, and not applied by `agent()` — the BUILD enumerates `tools/`,
 * so an eval driving the raw default export would measure a desk with none of
 * its five tools. This template declares its prompt inline in `agent.ts`, so
 * there is no `system-prompt.md` for `withSystemPrompt` to layer on.
 *
 * The glob is written here rather than reached for from a shared helper because
 * this file SHIPS — see `agent.test.ts`.
 */
import agentDef from "virtual:aai/agent";
import { stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import {
  type EvalToolCall,
  type EvalWorkflows,
  toolResultIn,
  toolResultsIn,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { recap, SAMPLE_RECORDING } from "./shared.ts";

/**
 * The key every step reads with `requireStepEnv` — the one name `agent.ts`
 * declares in `requiredEnv`.
 *
 * Passed as the agent env so the eval's workflow engine publishes it: the
 * provider calls are answered by a fake, but each asks for the key BEFORE it
 * makes its request, so a run with no key fails on the credential rather than
 * reaching the script. The ENVIRONMENT and nothing else — a template may not
 * read a developer's CLI config.
 */
const EVAL_ENV = { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "eval-scripted-key" };

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

/** How the scripted provider ends a job. */
type Ending = "completed" | "error";

/** A scripted provider, and the gate that holds its first status answer. */
type ScriptedProvider = {
  /** Every step request, in order — what the run really asked the provider. */
  readonly calls: readonly { url: string; method: string; body?: unknown }[];
  /** Let a held first poll answer. Idempotent. */
  readonly release: () => void;
};

/**
 * Answer AssemblyAI's batch API and the LLM gateway in memory.
 *
 * Through `stepFetch`'s published slot rather than `vi.stubGlobal("fetch")`,
 * which is the path a step really takes — and which leaves the SESSION's model
 * live, so a live case still measures the agent. An unrecognised request THROWS
 * rather than answering an empty 200: a step calling something nobody expected
 * is a finding, where an empty body reads as a provider that said nothing.
 *
 * The model leg is `stubGatewayRoute`'s, first, because it is the one leg whose
 * shape this file cannot check: the completion envelope is a WIRE shape, so a
 * field typed one off does not fail — `stepGenerate` reads no content, reports
 * an empty completion, and the case blames the recap. The reader routes off the
 * SDK's own completions PATH and answers `undefined` for everything else, which
 * is what lets it sit in front of the three batch legs below it.
 *
 * `hold` keeps the FIRST poll pending, and it is the only way to observe a run
 * that is still going: a durable `sleep` is skipped here, so an unheld run
 * burns its whole poll loop in milliseconds.
 */
function stubProvider(options: { hold?: boolean; ending?: Ending } = {}): ScriptedProvider {
  const gate = Promise.withResolvers<void>();
  const model = stubGatewayRoute(RECAP_JSON);
  let polls = 0;
  const stub = installStubStepFetch(async (request) => {
    const recapped = model.route(request);
    if (recapped) return recapped;
    if (request.method === "POST") return { body: { id: TRANSCRIPT_ID, status: "queued" } };
    // The compensation. A real DELETE removes the transcript from the account,
    // which is what makes "a failed run leaves nothing behind" a claim rather
    // than a comment — so the assertion that matters is that this was CALLED.
    if (request.method === "DELETE") return { body: {} };
    if (request.method === "GET") {
      polls += 1;
      if (options.hold === true && polls === 1) await gate.promise;
      return options.ending === "error"
        ? { body: { status: "error", error: "that recording could not be decoded" } }
        : { body: { status: "completed", text: TRANSCRIPT_TEXT, audio_duration: 254 } };
    }
    throw new Error(`unexpected step request in an eval: ${request.method} ${request.url}`);
  });
  return { calls: stub.calls, release: () => gate.resolve() };
}

/** `request_recap`'s two answers — it started one, or it found the live one. */
const RecapStart = z.union([
  z.object({ started: z.literal(true), runId: z.string().min(1) }),
  z.object({ started: z.literal(false), runId: z.string().min(1), note: z.string() }),
]);

/** `cancel_recap`'s answer. */
const Cancelled = z.object({ cancelled: z.boolean(), note: z.string() });

/**
 * Every `request_recap` answer in a turn, parsed.
 *
 * Parsed rather than regexed: a tool result reaches the event stream as a
 * serialized string, and a shape that stopped matching should fail HERE naming
 * the field instead of handing the next assertion `undefined`. That is
 * `toolResultsIn`'s job, and the half it does better than the filter-and-map
 * this was: a call with no result THROWS naming its position, where
 * `one.result !== undefined` dropped it — so a tool that was called and never
 * returned left a shorter list and a case that read the calls it did get.
 */
function recapStarts(calls: readonly EvalToolCall[]): readonly z.infer<typeof RecapStart>[] {
  return toolResultsIn(calls, "request_recap", RecapStart);
}

/**
 * The run id the FIRST `request_recap` of this turn reported.
 *
 * `recapStarts` rather than `toolResultIn`: a turn is allowed more than one call
 * here — the case below says so in as many words, a desk that asks twice being
 * the model's business — and the singular reader refuses a second one on
 * purpose. What is asserted about the extras is that each was REFUSED with the
 * run this found.
 */
function startedRunId(calls: readonly EvalToolCall[]): string {
  const [first] = recapStarts(calls);
  if (first === undefined) {
    throw new Error(
      `the desk called no request_recap: ${calls.map((one) => one.name).join(", ") || "(no tools)"}`,
    );
  }
  return first.runId;
}

/** Every tool call in this turn that READS a run, whichever the model picked. */
function readbacks(calls: readonly EvalToolCall[]): readonly EvalToolCall[] {
  return calls.filter((one) => one.name === "recap_status" || one.name === "recap_progress");
}

/** Requests of one method the run has made so far. */
function requests(provider: ScriptedProvider, method: string) {
  return provider.calls.filter((one) => one.method === method);
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

/**
 * Let the run finish before the case ends.
 *
 * Not tidiness: the scripted provider is unpublished when the test that
 * installed it finishes, so a body still mid-flight would make its next request
 * against whatever the next case publishes — or against the real provider, with
 * a real key. A run drained here COMPLETES rather than failing, and the last
 * thing it does on the way is delete its own transcript: the retention gate's
 * window closes with nobody having answered, which is the safe default. See the
 * header, and the case that pins it.
 */
async function drain(workflows: EvalWorkflows | undefined, provider: ScriptedProvider) {
  provider.release();
  for (const run of await (workflows?.runs() ?? [])) await workflows?.settle(run.runId, recap);
}

describeEval(
  agentDef,
  (test) => {
    test(
      "starts one run for the caller and will not pay for a second",
      async ({ session, workflows }) => {
        // Held, so the first run is unambiguously still live when the caller
        // asks again — which is the state the live-run check exists for.
        const provider = stubProvider({ hold: true });

        const first = await session.say(ASK);
        const runId = startedRunId(first.toolCalls);
        const again = await session.say("Actually, start it again from scratch, please.");

        // Temporal's workflow-id reuse policy, as this desk spells it: a caller
        // who asks twice is told about the run they already have. WHETHER the
        // model calls the tool a second time is its business — it may simply
        // remember — so each call it did make has to have been refused with the
        // run it found.
        for (const answer of recapStarts(again.toolCalls)) {
          expect(answer.started).toBe(false);
          expect(answer.runId).toBe(runId);
        }

        // The half that is not vacuous either way, and the one the caller pays
        // for: ONE run, and ONE submission to the provider.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.map((one) => one.runId)).toEqual([runId]);
        expect(runs[0]?.workflow).toBe("recap");
        const posts = requests(provider, "POST");
        expect(posts).toHaveLength(1);
        // And it submitted the recording the DESK supplies, because a phone
        // caller cannot read a URL aloud.
        const submitted = JSON.parse(String(posts[0]?.body));
        expect(submitted).toMatchObject({
          audio_url: SAMPLE_RECORDING,
          speaker_labels: true,
        });
        // NO `webhook_url`, asserted positively — see the third boundary in this
        // file's header. Nothing publishes a webhook minter here, so
        // `stepWebhookUrl` throws, `callbackUrl` degrades, and every run in this
        // file polls rather than parking on a callback. Pinning it here is what
        // stops an eval runtime that later publishes one from silently changing
        // which arm all of these cases measure.
        expect(Object.keys(submitted)).not.toContain("webhook_url");

        await drain(workflows, provider);
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
      async ({ session, workflows }) => {
        const provider = stubProvider({ hold: true });

        const started = await session.say(ASK);
        const runId = startedRunId(started.toolCalls);
        const turn = await session.say("How's that going?");

        const read = readbacks(turn.toolCalls);
        expect(read.length).toBeGreaterThan(0);
        const answered = read.map((one) => one.result ?? "").join("\n");

        // The load-bearing half: that readback happened while the run really
        // was in flight, waiting on the provider — which is the only state
        // these two tools exist for.
        const runs = await (workflows?.runs() ?? []);
        const live = runs.find((one) => one.runId === runId);
        expect(live?.status).toBe("running");
        expect(requests(provider, "GET")).toHaveLength(1);

        // WHICH readback tool the model picks is its business — the prompt
        // offers both — so the claim is about what it was TOLD, and each has its
        // own shape: `recap_progress` hands back the run's own latest line and
        // `recap_status` the snapshot's status. Compared against what the RUN
        // really wrote rather than against a literal, because which line that is
        // depends on how far the body got: with the durable `sleep` skipped here
        // the `PATIENCE` race resolves at once, so the note the caller would
        // hear two minutes in is already written.
        const lastLine = String(live?.reported.at(-1));
        expect(live?.reported.length).toBeGreaterThan(0);
        expect(answered).toMatch(new RegExp(`${literal(lastLine)}|Still working on that one`));
        expect(answered).not.toMatch(/Nothing started yet/);

        await drain(workflows, provider);
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "recap_progress", args: {} },
          "It's with the transcription service now — nothing back yet.",
        ],
      },
    );

    test(
      "cancelling says plainly what it did NOT roll back, and really does not",
      async ({ session, workflows }) => {
        const provider = stubProvider({ hold: true });

        const started = await session.say(ASK);
        const runId = startedRunId(started.toolCalls);
        const turn = await session.say("Forget it — cancel that, please.");

        const answer = toolResultIn(turn.toolCalls, "cancel_recap", Cancelled);
        expect(answer.cancelled).toBe(true);
        // The sentence is a documented promise of this template, not a
        // decoration: cancellation is NOT cooperative here, so the transcript
        // the run had already created stays on the account and the caller is
        // told so rather than left to assume a rollback.
        expect(answer.note).toMatch(/left behind/);
        expect(answer.note).toMatch(/does not roll back/);

        // And it is TRUE, which is the part only an eval with a real run can
        // check: the run is cancelled, and no compensating DELETE went out.
        const runs = await (workflows?.runs() ?? []);
        expect(runs.find((one) => one.runId === runId)?.status).toBe("cancelled");
        expect(requests(provider, "DELETE")).toEqual([]);

        // Released after the assertions on purpose: the body runs on regardless
        // (there is no queue here to stop delivering to, and Temporal's
        // deliver-cancellation-into-the-workflow is the one thing this template
        // says does not port), so anything it does afterwards is not what the
        // caller was told about.
        await drain(workflows, provider);
      },
      {
        stubReply: [
          ...START_TURN,
          { tool: "cancel_recap", args: {} },
          "Stopped it. The partial transcript stays on file — cancelling doesn't undo that.",
        ],
      },
    );

    test("nobody answers the retention gate, so the transcript is not kept", async ({
      workflows,
    }) => {
      // The gate's SAFE DEFAULT, and the branch of it this tier really does
      // reach: `ctx.waitFor` here carries a `timeoutMs` and no one can send a
      // payload, which is the closed window rather than a missing feature. So
      // this is the ordinary ending of every run in this file, and it is worth
      // an assertion of its own — a gate whose no-answer branch KEPT the data
      // would be a prompt with a grace period, and nothing else here would
      // notice the difference.
      const provider = stubProvider();

      const run = await workflows?.run(recap, {
        url: SAMPLE_RECORDING,
        requestedBy: "eval-session",
      });

      expect(run?.status).toBe("completed");
      // `answered: false` is the half that separates this from a caller who
      // said no: the desk reports which of the two happened rather than only
      // what it did.
      expect(run?.output).toMatchObject({ kept: false, answered: false });
      // And the default really is DELETE — the same request the compensation
      // makes, reached by the opposite path: this run succeeded.
      expect(requests(provider, "DELETE").map((one) => one.url)).toEqual([
        `https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`,
      ]);
      // The caller was ASKED first, which is what makes two minutes of silence
      // an answer at all.
      expect(run?.reported.join("\n")).toMatch(/Keep the transcript on file/);
    });

    test("a run that fails after creating a transcript deletes it again", async ({ workflows }) => {
      // Started from the CASE rather than through a tool, because the subject
      // is the saga and the failure has to be injected: the provider refuses
      // the job, which is the branch that unwinds the compensation stack.
      // `request_recap` is what the other three cases drive.
      const provider = stubProvider({ ending: "error" });

      const run = await workflows?.run(recap, {
        url: SAMPLE_RECORDING,
        requestedBy: "eval-session",
      });

      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/could not transcribe/);
      // The unwind, off the run's own narration — one compensation, named.
      const narration = run?.reported.join("\n") ?? "";
      expect(narration).toMatch(/undoing 1 step/);
      expect(narration).toMatch(`Discarding transcript ${TRANSCRIPT_ID}.`);
      // And it really happened: the transcript this run created was deleted
      // from the account, which is the promise "a failed recap leaves nothing
      // behind" rests on. An undo registered BEFORE its step, or a `catch`
      // that stopped compensating, fails here.
      expect(requests(provider, "DELETE").map((one) => one.url)).toEqual([
        `https://api.assemblyai.com/v2/transcript/${TRANSCRIPT_ID}`,
      ]);
    });
  },
  { env: EVAL_ENV },
);
