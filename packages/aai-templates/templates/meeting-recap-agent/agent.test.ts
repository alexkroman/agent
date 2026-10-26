// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the recap desk — the template that ports the Temporal workflow
 * patterns onto a voice call.
 *
 * Four tiers: the two tools against a stubbed `ctx.workflows`; the steps,
 * directly, against a stubbed provider; the body's helpers (the poll and the
 * gate) through `createWorkflowContext`, which records ORDERING and BRANCHING
 * and claims nothing about durability; and `recapFlow` itself on the real
 * replay engine (`runWorkflow`), which is the tier that reaches this desk's two
 * most expensive claims — a resume does not re-transcribe, and the RETENTION
 * GATE's unanswered window deletes.
 */

import agentDef from "virtual:aai/agent";
import { describeRun } from "@alexkroman1/aai";
import type {
  WorkflowTestRun,
  WorkflowTestStep,
  WorkflowTestWait,
} from "@alexkroman1/aai-runtime/testing";
import {
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  parseSchemaInput,
  runWorkflow,
  schemaInputIssues,
  stubGatewayRoute,
  type WorkflowContextRecorder,
} from "@alexkroman1/aai-runtime/testing";
import {
  describeAgent,
  installStubGateway,
  installStubStepFetch,
  installStubWorkflows,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import keepTranscript from "./tools/keep_transcript.ts";
import requestRecap from "./tools/request_recap.ts";
import recap, {
  askWhetherToKeep,
  awaitTranscript,
  checkTranscript,
  compensate,
  discardTranscript,
  SAMPLE_RECORDING,
  submitRecording,
  summarize,
  type TranscriptState,
} from "./workflows/recap.ts";

/** A finished recap, as the workflow's output reaches the status line. */
function finishedOutput(over: { kept?: boolean; answered?: boolean } = {}) {
  return {
    url: SAMPLE_RECORDING,
    headline: "Smoke reaches the east coast",
    points: ["a", "b", "c"],
    spoken: "Wildfire smoke drifted east and pushed air quality into the unhealthy range.",
    minutes: 4,
    kept: true,
    answered: true,
    requestedBy: "s_1",
    ...over,
  };
}

describeAgent(agentDef, (run) => {
  test("declares its workflow by its file name, with a schema and the key its steps read", async () => {
    expect(agentDef.workflows?.recap).toBe(recap);
    const parsed = await parseSchemaInput(recap.input, {
      url: "https://example.com/a.mp3",
      requestedBy: "s",
    });
    expect(parsed).toMatchObject({ url: "https://example.com/a.mp3" });
    expect(
      await schemaInputIssues(recap.input, { url: "not a url", requestedBy: "s" }),
    ).toBeDefined();
    // The steps reach the key with `requireStepEnv`, which nothing else in the
    // agent config would mention.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });

  describe("request_recap", () => {
    test("starts a run on the session's key, and asks to be TOLD when it lands", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      const ctx = createToolContext({ workflows });
      const result = await run(requestRecap, ctx);

      expect(workflows.start).toHaveBeenCalledWith(
        recap,
        { url: SAMPLE_RECORDING, requestedBy: ctx.sessionId },
        { notify: expect.stringContaining("one-sentence") },
      );
      expect(result).toMatchObject({ started: true, runId: "wrun_stub" });
    });

    test("uses the caller's recording when they named one", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      await run(
        requestRecap,
        { url: "https://example.com/board.mp3" },
        createToolContext({ workflows }),
      );
      expect(vi.mocked(workflows.start).mock.calls[0]?.[1]).toMatchObject({
        url: "https://example.com/board.mp3",
      });
    });

    test("REFUSES a second run while one is live, and hands back the one that exists", async () => {
      // Temporal's workflow-id reuse policy: a caller who asks twice would
      // otherwise pay for the same recording being transcribed twice.
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(recap, { status: "running" })],
      });
      const result = await run(requestRecap, createToolContext({ workflows }));
      expect(result).toMatchObject({ started: false, runId: "wrun_1" });
      expect(workflows.start).not.toHaveBeenCalled();
    });

    test("starts a fresh run once the previous one is terminal", async () => {
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(recap, { status: "completed", output: finishedOutput() })],
      });
      const result = await run(requestRecap, createToolContext({ workflows }));
      expect(result).toMatchObject({ started: true });
    });
  });

  describe("keep_transcript — the signal", () => {
    // A `ctx.workflows` where `signalRun` is the ONLY method that answers, so
    // these fail if the tool ever reaches for a run: the hook is addressed by
    // the def, the session's key and the label, which is the whole claim of
    // the tool — neither side spells a token.
    const signalOnly = (answer: boolean) => {
      const signalRun = vi.fn(async () => answer);
      return {
        signalRun,
        ctx: createToolContext({ workflows: createStubWorkflows({ signalRun }) }),
      };
    };

    test("signals the run's retention hook by the session's key and the label", async () => {
      const { signalRun, ctx } = signalOnly(true);
      const result = await run(keepTranscript, { keep: true }, ctx);
      expect(signalRun).toHaveBeenCalledWith(recap, "session", "retention", { keep: true });
      expect(result).toMatchObject({ answered: true, keep: true });
    });

    test("carries a DECLINE, not just an approval", async () => {
      // "Delete it" has to reach the run before the window closes, or the
      // caller waits two minutes for something they already said.
      const { signalRun, ctx } = signalOnly(true);
      await run(keepTranscript, { keep: false }, ctx);
      expect(signalRun).toHaveBeenCalledWith(recap, "session", "retention", { keep: false });
    });

    test("a token nobody holds is reported as SETTLED, not as a failure", async () => {
      const { ctx } = signalOnly(false);
      const result = await run(keepTranscript, { keep: true }, ctx);
      expect(result).toMatchObject({ answered: false, note: expect.stringContaining("settled") });
    });
  });
});

describe("what the status builtin says per run — the QUERY port", () => {
  test("reads back the ONE-SENTENCE version of a finished recap, and the transcript's fate", () => {
    const kept = createRunSnapshot(recap, { status: "completed", output: finishedOutput() });
    expect(describeRun(recap, kept)).toContain("air quality");
    expect(describeRun(recap, kept)).toContain("transcript kept");
    // The caller who never got round to answering should hear that the
    // transcript is gone, not just the recap.
    const deleted = createRunSnapshot(recap, {
      status: "completed",
      output: finishedOutput({ kept: false, answered: false }),
    });
    expect(describeRun(recap, deleted)).toContain("transcript deleted");
  });

  test("reports a live run as still working, and a failed one as ROLLED BACK", () => {
    expect(describeRun(recap, createRunSnapshot(recap, { status: "running" }))).toContain(
      "Still working",
    );
    const failed = createRunSnapshot(recap, { status: "failed", error: "provider unavailable" });
    expect(describeRun(recap, failed)).toContain("rolled back");
    expect(describeRun(recap, failed)).toContain("provider unavailable");
  });

  test("the cancel note says what cancelling does NOT roll back", () => {
    // The one Temporal behaviour that did not port: `cancel` stops replaying
    // the run, so the compensations never fire. A template that implied
    // otherwise would be teaching the wrong thing.
    expect(recap.cancelNote).toMatch(/left behind/);
    expect(recap.cancelNote).toMatch(/does not roll back/);
  });
});

// ---- The steps --------------------------------------------------------------

/** A provider answering `body` with `status`, into `stepFetch`'s own slot. */
function stubProvider(body: unknown, status = 200) {
  return installStubStepFetch(() => ({ status, body })).calls;
}

describe("the steps", () => {
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  describe("submitRecording", () => {
    test("posts the recording with the desk's own request, on the raw key", async () => {
      const calls = stubProvider({ id: "t_1", status: "queued" });
      expect(await submitRecording("https://example.com/a.mp3")).toBe("t_1");

      const call = calls[0];
      expect(call?.method).toBe("POST");
      expect(JSON.parse(String(call?.body))).toMatchObject({
        audio_url: "https://example.com/a.mp3",
        speaker_labels: true,
      });
      // AssemblyAI takes the key RAW — no `Bearer` prefix.
      const auth = Object.entries(call?.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "authorization",
      );
      expect(auth?.[1]).toBe("sk-test");
    });

    test("fails FATALLY on a bad key and plainly on a rate limit", async () => {
      stubProvider({ error: "nope" }, 401);
      await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/HTTP 401/);
      stubProvider({ error: "slow down" }, 429);
      await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/HTTP 429/);
    });

    test("refuses a response that names no transcript id", async () => {
      // A run that discovers that at the first poll has already lost the id it
      // needed to compensate with.
      stubProvider({ status: "queued" });
      await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/transcript id/);
    });

    test("asks the provider to CALL BACK when handed a URL, and OMITS the key otherwise", async () => {
      const calls = stubProvider({ id: "t_1", status: "queued" });
      await submitRecording(
        "https://example.com/a.mp3",
        "https://desk.example/hook/transcript:s_1",
      );
      expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
        webhook_url: "https://desk.example/hook/transcript:s_1",
      });
      // Absent on the wire, never a null: a provider handed a null for a URL is
      // entitled to refuse the whole submission.
      await submitRecording("https://example.com/a.mp3");
      expect(Object.keys(JSON.parse(String(calls[1]?.body)))).not.toContain("webhook_url");
    });
  });

  describe("checkTranscript", () => {
    test("reports a completed job with its text and duration", async () => {
      stubProvider({ status: "completed", text: "Hello there.", audio_duration: 254 });
      expect(await checkTranscript("t_1")).toEqual({
        status: "completed",
        text: "Hello there.",
        audioDuration: 254,
      });
    });

    test("carries the credential and asks for JSON", async () => {
      const calls = stubProvider({ status: "processing" });
      await checkTranscript("t_1");
      expect(calls[0]?.headers).toMatchObject({
        authorization: "sk-test",
        "content-type": "application/json",
      });
    });

    test("carries the provider's own failure message, and omits absent fields", async () => {
      stubProvider({ status: "error", error: "Transcoding failed" });
      expect(await checkTranscript("t_1")).toEqual({
        status: "error",
        error: "Transcoding failed",
      });
      // A key set to `undefined` does not survive the queue.
      stubProvider({ status: "processing" });
      expect(Object.keys(await checkTranscript("t_1"))).toEqual(["status"]);
    });

    test("refuses a status it does not recognise instead of polling forever", async () => {
      stubProvider({ status: "transcribing" });
      await expect(checkTranscript("t_1")).rejects.toThrow(/unknown transcript status/);
      // Valid JSON that is not this endpoint's object: no status to report, so
      // the sentence says exactly that rather than throwing a second time.
      stubProvider([{ status: "completed" }]);
      await expect(checkTranscript("t_1")).rejects.toThrow(/unknown transcript status: undefined/);
    });

    test("drops a field of the wrong type rather than failing the poll", async () => {
      // The job is running and `status` says so; a `text` the provider sent as
      // a number is one unusable field, not a reason to end a run that has
      // already paid for the transcription.
      stubProvider({ status: "processing", text: 42, error: [], audio_duration: "254" });
      expect(await checkTranscript("t_1")).toEqual({ status: "processing" });
      stubProvider({ status: "completed", text: "Hello.", audio_duration: null });
      expect(await checkTranscript("t_1")).toEqual({ status: "completed", text: "Hello." });
    });
  });

  describe("discardTranscript — the compensation", () => {
    test("deletes the transcript this run created", async () => {
      const calls = stubProvider({ id: "t_1" });
      await expect(discardTranscript("t_1")).resolves.toBeUndefined();
      expect(calls[0]?.method).toBe("DELETE");
      expect(calls[0]?.url).toContain("/t_1");
      expect(calls[0]?.headers).toMatchObject({ authorization: "sk-test" });
    });

    test("treats a 404 as success, because an undo must be safe to run twice", async () => {
      stubProvider("", 404);
      await expect(discardTranscript("t_1")).resolves.toBeUndefined();
    });

    test("still fails on a real error, so the engine retries it", async () => {
      stubProvider("", 503);
      await expect(discardTranscript("t_1")).rejects.toThrow(/HTTP 503/);
    });
  });

  describe("summarize", () => {
    function transcript(over: Partial<TranscriptState> = {}): TranscriptState {
      return { status: "completed", text: "We talked about smoke.", audioDuration: 254, ...over };
    }

    test("returns the recap the model produced, with the recording's length in minutes", async () => {
      installStubGateway(
        '{"headline":"Smoke","points":["a","b","c","d"],"spoken":"Smoke drifted east."}',
      );
      expect(await summarize("https://example.com/a.mp3", transcript())).toEqual({
        url: "https://example.com/a.mp3",
        headline: "Smoke",
        // Capped by the schema: a fourth point is dropped, not refused.
        points: ["a", "b", "c"],
        spoken: "Smoke drifted east.",
        minutes: 4,
      });
    });

    test("throws PLAINLY when the model answered with prose, so the step retries", async () => {
      // A model that ignored the format may well obey on the next attempt,
      // where a 401 will not.
      installStubGateway("Here is a recap of the recording.");
      await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(/Expected JSON/);
    });

    test("rejects a reply missing the spoken sentence as firmly as no JSON at all", async () => {
      installStubGateway('{"headline":"H","points":["a"]}');
      await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(/did not match/);
    });

    test("fails FATALLY on a transcript with no speech in it", async () => {
      installStubGateway('{"headline":"H","points":["a"],"spoken":"S."}');
      await expect(summarize("https://x/a.mp3", transcript({ text: "   " }))).rejects.toThrow(
        /no speech/,
      );
    });

    test("fails FATALLY with no API key rather than retrying", async () => {
      vi.stubEnv("ASSEMBLYAI_API_KEY", "");
      installStubGateway('{"headline":"H","points":["a"],"spoken":"S."}', { apiKey: false });
      await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(
        /ASSEMBLYAI_API_KEY/,
      );
    });
  });
});

// ---- The body's helpers -----------------------------------------------------

/** Every step of one name the body issued, in order. */
function recordedSteps(ctx: WorkflowContextRecorder, name: string) {
  return ctx.steps.filter((step) => step.name === name);
}

/** The run as `request_recap` starts it: keyed by the session, so the body can derive its tokens. */
const recapCtx = (options: Parameters<typeof createWorkflowContext>[0] = {}) =>
  createWorkflowContext({ workflow: "recap", key: "s_1", ...options });

describe("awaitTranscript — the polling port, and the callback over it", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /** A provider whose status endpoint answers `statuses` in order, the last repeating. */
  function stubStatuses(statuses: readonly Record<string, unknown>[]) {
    const stub = installStubStepFetch(() => ({
      body: statuses[Math.min(stub.calls.length - 1, statuses.length - 1)],
    }));
    return () => stub.calls.length;
  }

  /** A job still `processing` for `polls` reads, then completed. */
  const slowJob = (polls: number) =>
    stubStatuses([
      ...Array.from({ length: polls }, () => ({ status: "processing" })),
      { status: "completed", text: "Done.", audio_duration: 60 },
    ]);

  /** The callback token the body derives for that run — read off the context, never spelled. */
  const NUDGE = recapCtx().signalToken("transcript");

  test("parks on the callback ONCE, then polls on the cadence until the job settles", async () => {
    // No `hooks` entry, so the timed wait resolves `undefined` — the window
    // closing. A dropped delivery is the ordinary case a webhook has no answer
    // for, and the run must finish anyway.
    const polls = slowJob(2);
    const ctx = recapCtx();

    const state = await awaitTranscript("t_1", NUDGE, ctx);

    expect(state).toMatchObject({ status: "completed", text: "Done." });
    expect(polls()).toBe(3);
    expect(ctx.waited).toEqual([NUDGE]);
    expect(ctx.slept.map((one) => one.until)).toEqual([15_000, 15_000]);
  });

  test("a delivery is a NUDGE, not an answer: the run still READS the status", async () => {
    // The security property, and the reason an unauthenticated callback route
    // is safe here: the payload SAYS the job completed, the provider's own
    // endpoint says otherwise, and the provider wins.
    const polls = stubStatuses([
      { status: "processing" },
      { status: "completed", text: "The real transcript.", audio_duration: 60 },
    ]);
    const ctx = recapCtx({
      hooks: { [NUDGE]: { transcript_id: "t_1", status: "completed", text: "A LIE." } },
    });

    const state = await awaitTranscript("t_1", NUDGE, ctx);

    expect(state).toMatchObject({ status: "completed", text: "The real transcript." });
    expect(polls()).toBe(2);
    expect(ctx.waited).toEqual([NUDGE]);
  });

  test("stops on the provider's own terminal failure instead of waiting it out", async () => {
    const polls = stubStatuses([{ status: "error", error: "Transcoding failed" }]);
    await expect(awaitTranscript("t_1", NUDGE, createWorkflowContext())).rejects.toThrow(
      /Transcoding failed/,
    );
    expect(polls()).toBe(1);
  });

  test("gives up at the bound rather than polling a stuck job forever", async () => {
    stubStatuses([{ status: "processing" }]);
    await expect(awaitTranscript("t_1", NUDGE, createWorkflowContext())).rejects.toThrow(/Gave up/);
  });

  test("says 'still transcribing' ONCE past two minutes, and not for a job that finishes sooner", async () => {
    // A note per poll would be a caller told the same sentence every fifteen
    // seconds; a note for every job would be a desk calling a four-minute
    // recording a long one.
    const slow = createWorkflowContext();
    slowJob(20);
    await awaitTranscript("t_1", NUDGE, slow);
    expect(recordedSteps(slow, "checkTranscript:slow")).toHaveLength(1);

    const quick = createWorkflowContext();
    slowJob(3);
    await awaitTranscript("t_1", NUDGE, quick);
    expect(recordedSteps(quick, "checkTranscript:slow")).toEqual([]);
  });
});

describe("askWhetherToKeep — the expense port", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /** The run's own retention token, derived the way the body derives it. */
  const RETENTION = recapCtx().signalToken("retention");
  /** The gate, driven with or without an answer: a `hooks` entry, or its absence. */
  const gateCtx = (answer?: { keep: boolean }) =>
    recapCtx(answer === undefined ? {} : { hooks: { [RETENTION]: answer } });

  test("keeps the transcript when the caller says to, and deletes nothing", async () => {
    const provider = installStubStepFetch();
    const compensations = [{ label: "transcript t_1", undo: async () => undefined }];
    expect(await askWhetherToKeep("t_1", compensations, gateCtx({ keep: true }))).toEqual({
      kept: true,
      answered: true,
    });
    expect(provider.calls).toEqual([]);
    // The undo stays on the stack: a later failure still has something to reverse.
    expect(compensations).toHaveLength(1);
  });

  test("deletes on a DECLINE, and drops the undo it just performed", async () => {
    const calls = stubProvider({ id: "t_1" });
    const compensations = [{ label: "transcript t_1", undo: async () => undefined }];
    expect(await askWhetherToKeep("t_1", compensations, gateCtx({ keep: false }))).toEqual({
      kept: false,
      answered: true,
    });
    expect(calls[0]?.method).toBe("DELETE");
    expect(compensations).toHaveLength(0);
  });

  test("DELETES when nobody answers, which is what makes the window mean anything", async () => {
    const calls = stubProvider({ id: "t_1" });
    expect(await askWhetherToKeep("t_1", [], gateCtx())).toEqual({
      kept: false,
      answered: false,
    });
    expect(calls[0]?.method).toBe("DELETE");
  });

  test("asks BEFORE it waits, so the caller knows what they are answering", async () => {
    const ctx = gateCtx({ keep: true });
    installStubStepFetch();
    await askWhetherToKeep("t_1", [], ctx);
    expect(ctx.steps[0]?.name).toBe("noteGate");
    expect(ctx.waited).toEqual([RETENTION]);
  });
});

describe("compensate — the saga port", () => {
  test("unwinds newest-first, which is the order acquisitions were stacked in", async () => {
    const order: string[] = [];
    await compensate(
      [
        { label: "second", undo: async () => void order.push("second") },
        { label: "first", undo: async () => void order.push("first") },
      ],
      "because",
      createWorkflowContext(),
    );
    expect(order).toEqual(["second", "first"]);
  });

  test("a failing undo does not stop the ones behind it", async () => {
    // Ported deliberately from Temporal's `compensate`, which swallows: the run
    // already failed for a reason the caller needs.
    const order: string[] = [];
    const ctx = createWorkflowContext();
    await compensate(
      [
        {
          label: "broken",
          undo: async () => {
            throw new Error("the provider declined the delete");
          },
        },
        { label: "fine", undo: async () => void order.push("fine") },
      ],
      "because",
      ctx,
    );
    expect(order).toEqual(["fine"]);
    expect(ctx.steps.map((step) => step.name)).toEqual(["noteUnwind", "noteUndoFailed"]);
  });

  test("does nothing at all when nothing was acquired", async () => {
    const ctx = createWorkflowContext();
    await compensate([], "nothing was acquired", ctx);
    expect(ctx.steps).toEqual([]);
  });
});

/**
 * `recapFlow` itself, on the real replay engine: the run really parks, really
 * resumes off its journal, and really closes its windows.
 *
 * A spec publishes no webhook minter, so the submit carries no `webhook_url` —
 * and the poll still parks on the callback window FIRST, which is the arm a
 * deployment with no public URL takes. Here the window is ended the way the
 * provider ends it, with a delivery on the callback label (`run.signalRun`);
 * `expireWaits()` is kept for the retention gate's unanswered branch, which
 * nothing public can reach — that is `SleepRecord.kind`'s entire reason.
 */
describe("the run is DURABLE", () => {
  const INPUT = { url: "https://example.com/standup.mp3", requestedBy: "sess_1" };
  const RECAP = '{"headline":"Standup","points":["a","b"],"spoken":"They shipped it."}';
  const PROCESSING = { id: "t_1", status: "processing" };
  const DONE = { id: "t_1", status: "completed", text: "We shipped it.", audio_duration: 600 };
  /** What AssemblyAI posts to the callback URL: an edge, never an answer. */
  const NUDGE = { transcript_id: "t_1", status: "completed" };

  /**
   * The provider and the model, behind ONE published `stepFetch`. `transcript`
   * is a list of successive `GET` answers, the last repeating.
   */
  function stubWorld(transcript: readonly Record<string, unknown>[], recapReply = RECAP) {
    const model = stubGatewayRoute(recapReply);
    const deletes: string[] = [];
    let polls = 0;
    const provider = installStubStepFetch((request) => {
      const routed = model.route(request);
      if (routed) return routed;
      if (request.method === "DELETE") {
        deletes.push(request.url);
        return { status: 200, body: {} };
      }
      if (request.method === "POST") return { status: 200, body: { id: "t_1", status: "queued" } };
      const at = Math.min(polls++, transcript.length - 1);
      return { status: 200, body: transcript[at] ?? {} };
    });
    return { model, deletes, provider };
  }

  const stepKeys = (run: WorkflowTestRun<unknown>) => run.steps.map((step) => step.key);
  const journaledStep = (
    run: WorkflowTestRun<unknown>,
    name: string,
  ): WorkflowTestStep | undefined => run.steps.find((step) => step.name === name);
  const parkKinds = (waits: readonly WorkflowTestWait[]) => waits.map((wait) => wait.kind);

  /** The run as the tool starts it: keyed by the session, which its tokens derive from. */
  const KEY = "sess_1";

  /** Through the callback and the one poll, to the gate. */
  async function toTheGate() {
    const run = await runWorkflow(agentDef, "recap", INPUT, { key: KEY });
    await run.signalRun("transcript", NUDGE); // the provider calls back
    await run.advanceSleep(); // the poll cadence
    return run;
  }

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("submits once, then parks on the callback window before any read", async () => {
    stubWorld([PROCESSING, DONE]);
    const run = await runWorkflow(agentDef, "recap", INPUT, { key: KEY });

    expect(run.status).toBe("running");
    expect(stepKeys(run)).toEqual(["submitRecording#0"]);
    expect(parkKinds(run.waits)).toEqual(["hookTimeout"]);
  });

  test("resumes past the callback and the poll WITHOUT re-submitting the recording", async () => {
    // Twenty minutes of provider time is already paid for, and a resume must
    // not spend it again.
    const world = stubWorld([PROCESSING, DONE]);
    const run = await toTheGate();

    // Parked again, now on the retention gate — a hook with a deadline.
    expect(run.status).toBe("running");
    expect(stepKeys(run)).toEqual([
      "checkTranscript#0",
      "checkTranscript#1",
      "noteGate#0",
      "submitRecording#0",
      "summarize#0",
    ]);
    expect(run.deliveries).toBe(3);
    // ONE submit across three walks, and one model call.
    expect(
      world.provider.calls.filter((call) => call.method === "POST" && !call.url.includes("chat")),
    ).toHaveLength(1);
    expect(world.model.calls).toHaveLength(1);
    // Two windows and a sleep, read off the journal the run really lives in:
    // `wakeUp` reaches only the sleep, which is why "send it now" can never
    // answer an approval window.
    expect(parkKinds(run.waits).toSorted()).toEqual(["hookTimeout", "hookTimeout", "sleep"]);
  });

  test("an answer of KEEP leaves the transcript on the account", async () => {
    const world = stubWorld([PROCESSING, DONE]);
    const run = await toTheGate();
    await run.signalRun("retention", { keep: true });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ kept: true, answered: true, requestedBy: "sess_1" });
    expect(journaledStep(run, "discardOnDecline")).toBeUndefined();
    expect(world.deletes).toEqual([]);
  });

  test("an UNANSWERED window deletes, which is the safe default the gate exists for", async () => {
    const world = stubWorld([PROCESSING, DONE]);
    const run = await toTheGate();
    await run.expireWaits();

    expect(run.status).toBe("completed");
    // `answered: false` is the distinction the type carries: the caller did not
    // decline, they said nothing, and the desk deleted anyway.
    expect(run.output).toMatchObject({ kept: false, answered: false });
    expect(journaledStep(run, "discardOnDecline")).toBeDefined();
    expect(world.deletes).toEqual(["https://api.assemblyai.com/v2/transcript/t_1"]);

    // And a signal that arrives after the window closed cannot reopen it.
    await run.signalRun("retention", { keep: true });
    expect(run.signalled).toBe(false);
    expect(run.output).toMatchObject({ kept: false });
  });

  test("a failure after the transcript exists UNWINDS it, and the run still fails", async () => {
    // The saga. `summarize` is given prose instead of JSON on every attempt, so
    // the step exhausts its patience and the body's catch runs the compensation
    // stack — which must delete the transcript the run acquired.
    const world = stubWorld([DONE], "Here is a recap, in prose, as you did not ask.");
    const run = await runWorkflow(agentDef, "recap", INPUT, { key: KEY });
    await run.signalRun("transcript", NUDGE);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/JSON/i);
    expect(journaledStep(run, "discardTranscript")).toBeDefined();
    expect(world.deletes).toHaveLength(1);
  });

  test("a worker that dies MID-UNWIND resumes it rather than starting it over", async () => {
    // The saga's headline claim: a crash part-way through the unwind resumes
    // with the already-run compensations replayed from the journal and
    // re-issues only what is left — the property a `finally` cannot have.
    // `crashAt` kills the delivery that reaches `discardTranscript` AFTER the
    // attempt has been charged and before the body runs, which is where a real
    // death lands.
    const world = stubWorld([DONE], "Here is a recap, in prose, as you did not ask.");
    const run = await runWorkflow(agentDef, "recap", INPUT, {
      key: KEY,
      crashAt: "discardTranscript",
    });
    await run.signalRun("transcript", NUDGE);

    expect(run.crashed).toBe(true);
    // The transcript is still on the account: announced and never performed.
    expect(world.deletes).toEqual([]);

    await run.restart();

    expect(run.status).toBe("failed");
    // Deleted ONCE, by the resumed unwind rather than by a second one, with
    // the narration out of the journal on the second walk.
    expect(world.deletes).toHaveLength(1);
    expect(journaledStep(run, "noteUnwind")?.attempts).toBe(1);
    expect(stepKeys(run)).toEqual([
      "checkTranscript#0",
      "discardTranscript#0",
      "noteUnwind#0",
      "submitRecording#0",
      "summarize#0",
    ]);
  });
});
