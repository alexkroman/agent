// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the recap desk — the template that ports the Temporal workflow
 * patterns onto a voice call.
 *
 * Three tiers, and the line between them is what this file is careful about:
 *
 * - **The tools**, against a stubbed `ctx.workflows`. That is the only honest
 *   way to unit-test them (the real client needs a Workflow DevKit world), and
 *   it is enough: what the agent half promises is that the handoff passes a
 *   correlation key, that a second request finds the live run instead of paying
 *   for a second transcription, and that a cancel says out loud what cancelling
 *   does not do.
 * - **The steps**, directly. Imported through vitest with no bundler in the
 *   path a step is an ordinary async function, so its HTTP
 *   handling, its retryable/fatal split and its JSON contract with the model are
 *   all testable.
 * - **The body's two helpers** — the poll loop and the compensation unwind —
 *   with `sleep` stubbed. What that asserts is ORDERING and BRANCHING, which is
 *   ordinary logic and worth pinning; it asserts nothing about durability,
 *   replay or suspension, and could not. `recapFlow` itself is deliberately not
 *   driven here for exactly that reason — a body test dressed up as a durability
 *   test would be the worse failure. `aai-cli`'s
 *   `dev-workflow.scenario.test.ts` is the tier that builds a project and
 *   runs a real one.
 */

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { WorkflowClient } from "@alexkroman1/aai";
import {
  createRunSnapshot,
  createToolContext,
  createWorkflowCtx,
  parseSchemaInput,
  schemaInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import {
  installStubStepFetch,
  mockWorkflows,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { recap } from "./shared.ts";
import {
  askWhetherToKeep,
  awaitTranscript,
  checkTranscript,
  compensate,
  discardTranscript,
  recapFlow,
  submitRecording,
  summarize,
  type TranscriptState,
} from "./workflows/recap.ts";
import { retentionToken } from "./workflows/tokens.ts";

/**
 * Every tool here is driven through the agent's own table, by the name the model
 * calls.
 *
 * The second parameter is args-or-context, which is `runTool`'s own shape: four
 * of this desk's five tools take no arguments, and the `{}` those calls were
 * obliged to pass sat between the two values a reader cares about.
 */
const run = toolRunner(agentDef);

/**
 * A `ctx.workflows` that records `start` and answers the lookups from a fixture.
 *
 * `mockWorkflows` (`@alexkroman1/aai/testing/vitest`) is the whole thing — a
 * `vi.fn` per method over one `runs` list, with `stream`/`streamTail` left
 * rejecting because `recap_progress` reads progress through `lastLine` and
 * composing those two by hand is the hazard `lastLine` exists to remove. What
 * is local is only which workflow this desk declares.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  return mockWorkflows({ runs, names: ["recap"] });
}

/** A finished recap, as the workflow's output reaches the tools. */
function finishedOutput(over: { kept?: boolean; answered?: boolean } = {}) {
  return {
    url: "https://assembly.ai/wildfires.mp3",
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

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["recap"]);
    expect(agentDef.workflows?.recap).toBe(recap);
  });

  test("with an input schema, so a bad URL fails at the call site", async () => {
    // `parseSchemaInput` / `schemaInputIssues` rather than a reach through
    // `["~standard"].validate`: that is the vendor WIRE contract, and whether it
    // answers synchronously or with a promise is the vendor's business — a
    // missing `await` there leaves `.issues` undefined and the refusing half
    // passes for the wrong reason.
    const parsed = await parseSchemaInput(recap.input, {
      url: "https://example.com/a.mp3",
      requestedBy: "s",
    });
    expect(parsed).toMatchObject({ url: "https://example.com/a.mp3" });
    expect(
      await schemaInputIssues(recap.input, { url: "not a url", requestedBy: "s" }),
    ).toBeDefined();
  });

  test("and names the credential its steps read, so a deploy checks for it", () => {
    // The steps reach the key with `requireStepEnv`, which no part of the agent
    // config would otherwise mention.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });

  test("discovers every tool in tools/, by file name", () => {
    // Discovered, not declared: every name here is a file in `tools/`.
    expect(Object.keys(agentDef.tools).sort()).toEqual([
      "cancel_recap",
      "keep_transcript",
      "recap_progress",
      "recap_status",
      "request_recap",
    ]);
  });
});

describe("request_recap", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await run("request_recap", ctx);

    expect(workflows.start).toHaveBeenCalledWith(
      recap,
      { url: expect.stringContaining("http"), requestedBy: ctx.sessionId },
      // `key` is the DURABLE handle — a later call finds the run by it — and
      // `notify` is the live one: this session is told when the run lands.
      { key: ctx.sessionId, notify: expect.stringContaining("one-sentence") },
    );
    expect(result).toMatchObject({ started: true, runId: "wrun_stub" });
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await run("request_recap", createToolContext({ workflows }));
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(recap);
  });

  test("uses the caller's recording when they named one", async () => {
    const workflows = stubWorkflows();
    await run(
      "request_recap",
      { url: "https://example.com/board.mp3" },
      createToolContext({ workflows }),
    );
    expect(vi.mocked(workflows.start).mock.calls[0]?.[1]).toMatchObject({
      url: "https://example.com/board.mp3",
    });
  });

  test("REFUSES a second run while one is live, and hands back the one that exists", async () => {
    // Temporal's workflow-id reuse policy, spelled with what this SDK has. The
    // failure it prevents is not tidiness: a caller who asks twice would
    // otherwise pay for the same recording being transcribed twice.
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    const result = await run("request_recap", createToolContext({ workflows }));
    expect(result).toMatchObject({ started: false, runId: "wrun_1" });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  test("starts a fresh run once the previous one is terminal", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "recap", status: "completed", output: finishedOutput() }),
    ]);
    const result = await run("request_recap", createToolContext({ workflows }));
    expect(result).toMatchObject({ started: true });
    expect(workflows.start).toHaveBeenCalledTimes(1);
  });
});

describe("recap_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await run("recap_status", ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads back the ONE-SENTENCE version of a finished recap", async () => {
    // The output carries a `spoken` field for exactly this: the headline and
    // three points are for an eye, and this tool answers an ear.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "recap", status: "completed", output: finishedOutput() }),
    ]);
    const result = (await run("recap_status", createToolContext({ workflows }))) as {
      runs: string[];
    };
    expect(result.runs[0]).toContain("air quality");
  });

  test("names the transcript's fate, so an unanswered gate is not silent", async () => {
    // The caller who never got round to answering should hear that the
    // transcript is gone, not just the recap.
    const runs = [
      createRunSnapshot({
        workflow: "recap",
        status: "completed",
        output: finishedOutput({ kept: false, answered: false }),
      }),
    ];
    const result = (await run(
      "recap_status",
      createToolContext({ workflows: stubWorkflows(runs) }),
    )) as { runs: string[] };
    expect(result.runs[0]).toContain("transcript deleted");
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({
      workflows: stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]),
    });
    const result = (await run("recap_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working");
  });

  test("says a failed run was ROLLED BACK, because it was", async () => {
    // The saga's whole point, said out loud: the run compensated before it
    // failed, so there is nothing left on the account and nothing for the caller
    // to chase.
    const runs = [
      createRunSnapshot({ workflow: "recap", status: "failed", error: "provider unavailable" }),
    ];
    const result = (await run(
      "recap_status",
      createToolContext({ workflows: stubWorkflows(runs) }),
    )) as { runs: string[] };
    expect(result.runs[0]).toContain("rolled back");
    expect(result.runs[0]).toContain("provider unavailable");
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await run("recap_status", ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(recap, ctx.sessionId, { limit: 3 });
  });
});

describe("recap_progress", () => {
  test("reads the run's own progress line rather than its status", async () => {
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    vi.mocked(workflows.lastLine).mockResolvedValue("Transcript processing.");
    const result = await run("recap_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ progress: "Transcript processing." });
  });

  test("asks for the LAST line, not the whole log", async () => {
    // Every poll narrates, so a twenty-minute run's whole log is eighty lines.
    // `lastLine` is the whole request — the bound that keeps an empty channel
    // from hanging belongs to the method, so nothing here composes
    // `streamTail` and `stream`.
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    vi.mocked(workflows.lastLine).mockResolvedValue("a");
    await run("recap_progress", createToolContext({ workflows }));
    expect(workflows.lastLine).toHaveBeenCalledWith("wrun_1");
  });

  test("a run that has written nothing yet says so", async () => {
    // `lastLine` resolves `undefined` for an empty channel, and this is the arm
    // the tool branches on. That an empty channel does not HANG — it is never
    // closed, so a stream opened on one waits for a line that may never come —
    // is `lastLine`'s own guarantee now, and `aai`'s to test.
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    const result = await run("recap_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: expect.stringContaining("nothing to report") });
  });
});

describe("keep_transcript — the signal", () => {
  test("signals the run's retention hook on the token BOTH sides derive", async () => {
    // The token is the contract. `workflows/tokens.ts` is the one place it is
    // spelled, which is what stops the body waiting on a string the tool never
    // sends — a drift whose only symptom is `signal` answering false.
    const workflows = stubWorkflows();
    const signal = vi.fn(async () => true);
    const ctx = createToolContext({ workflows: { ...workflows, signal } });
    const result = await run("keep_transcript", { keep: true }, ctx);

    expect(signal).toHaveBeenCalledWith(retentionToken(ctx.sessionId), { keep: true });
    expect(result).toMatchObject({ answered: true, keep: true });
  });

  test("carries a DECLINE, not just an approval", async () => {
    // Three outcomes, and this is the one a boolean gate loses if the tool only
    // ever signals on yes: "delete it" has to reach the run before the window
    // closes, or the caller waits two minutes for something they already said.
    const signal = vi.fn(async () => true);
    const ctx = createToolContext({ workflows: { ...stubWorkflows(), signal } });
    await run("keep_transcript", { keep: false }, ctx);
    expect(signal).toHaveBeenCalledWith(expect.any(String), { keep: false });
  });

  test("a token nobody holds is reported as SETTLED, not as a failure", async () => {
    // The ordinary case: the window closed, or the caller answered a question
    // nobody asked.
    const signal = vi.fn(async () => false);
    const ctx = createToolContext({ workflows: { ...stubWorkflows(), signal } });
    const result = await run("keep_transcript", { keep: true }, ctx);
    expect(result).toMatchObject({ answered: false, note: expect.stringContaining("settled") });
  });
});

describe("cancel_recap", () => {
  test("cancels the live run", async () => {
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    const result = await run("cancel_recap", createToolContext({ workflows }));
    expect(workflows.cancel).toHaveBeenCalledWith("wrun_1");
    expect(result).toMatchObject({ cancelled: true });
  });

  test("says the transcript is LEFT BEHIND, because cancellation is not cooperative here", async () => {
    // The one Temporal behaviour that did not port. Temporal delivers
    // cancellation into the workflow, so the saga's catch runs; `cancel` here
    // stops replaying the run, so the compensations never fire. A template that
    // implied otherwise would be teaching the wrong thing.
    const workflows = stubWorkflows([createRunSnapshot({ workflow: "recap", status: "running" })]);
    const result = (await run("cancel_recap", createToolContext({ workflows }))) as {
      note: string;
    };
    expect(result.note).toContain("left behind");
  });

  test("a run that had already finished is reported honestly, not as a failure", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "recap", status: "completed", output: finishedOutput() }),
    ]);
    vi.mocked(workflows.cancel).mockResolvedValue(false);
    const result = await run("cancel_recap", createToolContext({ workflows }));
    expect(result).toMatchObject({ cancelled: false, note: "That one had already finished." });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await run("cancel_recap", createToolContext({ workflows }));
    expect(result).toMatchObject({ cancelled: false, note: "Nothing started yet." });
    expect(workflows.cancel).not.toHaveBeenCalled();
  });
});

// ---- The steps --------------------------------------------------------------

/**
 * A provider answering `body` with `status`, recording what it was asked.
 *
 * Published into `stepFetch`'s OWN slot, not over `globalThis.fetch`. Every
 * request in this file goes through `stepFetch` — `request()` and
 * `discardTranscript` reach it directly, `stepTranscribeSubmitClassified`
 * through the SDK — and `step-fetch.ts` falls back to `globalThis.fetch` only
 * when nothing is published. A global stub therefore passed while exercising a
 * path production never takes; every sibling template already stubs the slot,
 * and `link-digest/agent.test.ts` states the rule this one used to break.
 *
 * `installStubStepFetch` unpublishes on `onTestFinished`, so there is no restore
 * registry here and a stub cannot reach the next file.
 */
function stubProvider(body: unknown, status = 200) {
  return installStubStepFetch(() => ({ status, body })).calls;
}

describe("submitRecording", () => {
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is. `unstubEnvs` clears it per test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("posts the recording and returns the job id", async () => {
    const calls = stubProvider({ id: "t_1", status: "queued" });
    expect(await submitRecording("https://example.com/a.mp3")).toEqual({ id: "t_1" });

    const call = calls[0];
    expect(call?.method).toBe("POST");
    // `speaker_labels` is this desk's own request, carried through the SDK's
    // `params` passthrough; the model field is the SDK's and is PLURAL.
    expect(JSON.parse(String(call?.body))).toMatchObject({
      audio_url: "https://example.com/a.mp3",
      speaker_labels: true,
    });
    // AssemblyAI takes the key RAW — no `Bearer` prefix, unlike the
    // OpenAI-compatible LLM gateway `summarize` calls. The SDK spells the
    // header `Authorization`; HTTP header names are case-insensitive, so the
    // lookup is too rather than pinning one casing.
    const auth = Object.entries(call?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(auth?.[1]).toBe("sk-test");
  });

  test("fails FATALLY on a bad key and plainly on a rate limit", async () => {
    // The retry policy in one assertion: a 401 answers the same way on the
    // fourth attempt, a 429 is what retries are for.
    stubProvider({ error: "nope" }, 401);
    await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/HTTP 401/);
    stubProvider({ error: "slow down" }, 429);
    await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/HTTP 429/);
  });

  test("refuses a response that names no transcript id", async () => {
    // Nothing downstream can poll without one, and a run that discovers that at
    // the first poll has already lost the id it needed to compensate with.
    stubProvider({ status: "queued" });
    await expect(submitRecording("https://example.com/a.mp3")).rejects.toThrow(/transcript id/);
  });
});

describe("checkTranscript", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("reports a completed job with its text and duration", async () => {
    stubProvider({ status: "completed", text: "Hello there.", audio_duration: 254 });
    expect(await checkTranscript("t_1")).toEqual({
      status: "completed",
      text: "Hello there.",
      audioDuration: 254,
    });
  });

  test("carries the provider's own failure message through", async () => {
    stubProvider({ status: "error", error: "Transcoding failed" });
    expect(await checkTranscript("t_1")).toMatchObject({
      status: "error",
      error: "Transcoding failed",
    });
  });

  test("omits absent fields rather than setting them to undefined", async () => {
    // `exactOptionalPropertyTypes` makes those different types, and the result
    // crosses a queue — a key set to `undefined` does not survive the trip.
    stubProvider({ status: "processing" });
    expect(Object.keys(await checkTranscript("t_1"))).toEqual(["status"]);
  });

  test("refuses a status it does not recognise instead of polling forever", async () => {
    // The loop's exit conditions are `completed` and `error`; an unknown status
    // is neither, so it would poll to the bound and then fail with the wrong
    // reason.
    stubProvider({ status: "transcribing" });
    await expect(checkTranscript("t_1")).rejects.toThrow(/unknown transcript status/);
  });
});

describe("discardTranscript — the compensation", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("deletes the transcript this run created", async () => {
    const calls = stubProvider({ id: "t_1" });
    await expect(discardTranscript("t_1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/t_1");
  });

  test("treats a 404 as success, because an undo must be safe to run twice", async () => {
    // The property every compensation needs: a replay re-enters a world where
    // the undo may already have happened, and an undo that fails there would
    // fail the unwind for having succeeded.
    stubProvider("", 404);
    await expect(discardTranscript("t_1")).resolves.toBeUndefined();
  });

  test("still fails on a real error, so the DevKit retries it", async () => {
    stubProvider("", 503);
    await expect(discardTranscript("t_1")).rejects.toThrow(/HTTP 503/);
  });
});

describe("summarize", () => {
  /** A finished transcript, typed rather than cast — the shape a step really gets. */
  function transcript(over: Partial<TranscriptState> = {}): TranscriptState {
    return { status: "completed", text: "We talked about smoke.", audioDuration: 254, ...over };
  }

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("returns the recap the model produced, with the recording's length in minutes", async () => {
    stubGateway('{"headline":"Smoke","points":["a","b","c"],"spoken":"Smoke drifted east."}');
    expect(await summarize("https://example.com/a.mp3", transcript())).toEqual({
      url: "https://example.com/a.mp3",
      headline: "Smoke",
      points: ["a", "b", "c"],
      spoken: "Smoke drifted east.",
      // Rounded from the provider's seconds — a voice reply says "four minutes",
      // never "254 seconds".
      minutes: 4,
    });
  });

  test("unwraps a fenced reply rather than failing on it", async () => {
    stubGateway('```json\n{"headline":"H","points":["a"],"spoken":"S."}\n```');
    expect((await summarize("https://x/a.mp3", transcript())).headline).toBe("H");
  });

  test("throws PLAINLY when the model answered with prose, so the step retries", async () => {
    // The distinction that is the whole retry policy: a model that ignored the
    // format may well obey on the next attempt, where a 401 will not.
    stubGateway("Here is a recap of the recording.");
    // The SDK's message, not this template's: `stepGenerateJson` owns the
    // unwrap/parse/validate chain now, and a plain throw is what the DevKit
    // retries.
    await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(/Expected JSON/);
  });

  test("rejects a reply missing the spoken sentence as firmly as no JSON at all", async () => {
    // Without it the announced turn has nothing to read, which is the one field
    // this template's output exists for.
    stubGateway('{"headline":"H","points":["a"]}');
    await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(/did not match/);
  });

  test("fails FATALLY on a transcript with no speech in it", async () => {
    // A completed transcript holds the same nothing on every attempt — silence,
    // or a file with no speech. Retrying it five times buys nothing.
    stubGateway('{"headline":"H","points":["a"],"spoken":"S."}');
    await expect(summarize("https://x/a.mp3", transcript({ text: "   " }))).rejects.toThrow(
      /no speech/,
    );
  });

  test("fails FATALLY with no API key rather than retrying five times", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway('{"headline":"H","points":["a"],"spoken":"S."}');
    await expect(summarize("https://x/a.mp3", transcript())).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("is called with more attempts than the default, a rate limit and a bad format both happening", async () => {
    // The policy is an argument to `ctx.step` now, so it is observable only at
    // the call. `runSteps: false` and a skeleton of results: the subject is what
    // the body ASKED FOR.
    const ctx = createWorkflowCtx({
      runSteps: false,
      results: {
        submitRecording: { id: "t_1" },
        checkTranscript: { status: "completed", text: "Done.", durationMs: 1 },
        summarize: { headline: "H", points: [], spoken: "S." },
      },
      hooks: { [retentionToken("Ada")]: { keep: true } },
    });
    await recapFlow({ url: "https://x/a.mp3", requestedBy: "Ada" }, ctx);

    const step = ctx.steps.find((entry) => entry.name === "summarize");
    expect(step?.maxAttempts).toBeGreaterThan(3);
  });
});

// ---- The body's helpers -----------------------------------------------------

describe("awaitTranscript — the polling port", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /** A provider whose status endpoint answers `statuses` in order. */
  function stubStatuses(statuses: readonly Record<string, unknown>[]) {
    // Into `stepFetch`'s slot, for the reason `stubProvider` above gives.
    const stub = installStubStepFetch(() => ({
      body: statuses[Math.min(stub.calls.length - 1, statuses.length - 1)],
    }));
    return () => stub.calls.length;
  }

  test("keeps polling while the job is queued or processing", async () => {
    const polls = stubStatuses([
      { status: "queued" },
      { status: "processing" },
      { status: "completed", text: "Done.", audio_duration: 60 },
    ]);
    const state = await awaitTranscript("t_1", createWorkflowCtx());
    expect(state).toMatchObject({ status: "completed", text: "Done." });
    expect(polls()).toBe(3);
  });

  test("stops on the provider's own terminal failure instead of waiting it out", async () => {
    // `error` is terminal: polling a failed job to the bound would spend twenty
    // minutes learning what the first answer already said.
    const polls = stubStatuses([{ status: "error", error: "Transcoding failed" }]);
    await expect(awaitTranscript("t_1", createWorkflowCtx())).rejects.toThrow(/Transcoding failed/);
    expect(polls()).toBe(1);
  });

  test("gives up at the bound rather than polling a stuck job forever", async () => {
    stubStatuses([{ status: "processing" }]);
    await expect(awaitTranscript("t_1", createWorkflowCtx())).rejects.toThrow(/Gave up/);
  });
});

describe("askWhetherToKeep — the expense port", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /**
   * The gate, driven with or without an answer.
   *
   * This block used to be forty lines of DevKit scaffolding: `vi.mock("workflow")`
   * over `createHook` and `sleep`, plus a hand-built `Hook` assembled by hanging
   * members on a real promise, plus a never-resolving `sleep` so the two sides of
   * a `Promise.race` could not settle in an order that decided the test instead
   * of the branch. The gate is ONE call now — `ctx.waitFor(token, { timeoutMs })`
   * — so an answer is a `hooks` entry and the no-answer branch is its absence.
   * What is pinned is unchanged: the three outcomes and the safe default.
   */
  const gateCtx = (answer?: { keep: boolean }) =>
    createWorkflowCtx(answer === undefined ? {} : { hooks: { [retentionToken("s_1")]: answer } });

  test("keeps the transcript when the caller says to, and deletes nothing", async () => {
    const provider = installStubStepFetch();

    const compensations = [{ label: "transcript t_1", undo: async () => undefined }];
    expect(await askWhetherToKeep("s_1", "t_1", compensations, gateCtx({ keep: true }))).toEqual({
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
    expect(await askWhetherToKeep("s_1", "t_1", compensations, gateCtx({ keep: false }))).toEqual({
      kept: false,
      answered: true,
    });
    expect(calls[0]?.method).toBe("DELETE");
    // Leaving it would be harmless — the undo tolerates a 404 — and would still
    // narrate an unwind that reverses something already gone.
    expect(compensations).toHaveLength(0);
  });

  test("DELETES when nobody answers, which is what makes the window mean anything", async () => {
    // The safe default, and the whole reason the gate is a gate: a no-answer
    // branch that kept the data would be a prompt with a grace period. No
    // `hooks` entry is exactly the closed-window case, because the wait carries a
    // `timeoutMs` and so has an unanswered branch to take.
    const calls = stubProvider({ id: "t_1" });

    expect(await askWhetherToKeep("s_1", "t_1", [], gateCtx())).toEqual({
      kept: false,
      answered: false,
    });
    expect(calls[0]?.method).toBe("DELETE");
  });

  test("asks BEFORE it waits, so the caller knows what they are answering", async () => {
    // The ordering that replaced `createHook`'s claim-then-ask dance. Under the
    // DevKit the hook registered nothing until the workflow suspended, so an
    // answer sent before the claim landed was told "nobody is listening" —
    // indistinguishable from being late — and the body had to call
    // `getConflict()` first to force it. `ctx.waitFor` registers the token as
    // part of waiting, by construction, so what is left to assert is the thing
    // that still matters to a person: the note goes out first.
    const ctx = gateCtx({ keep: true });
    installStubStepFetch();

    await askWhetherToKeep("s_1", "t_1", [], ctx);

    expect(ctx.steps[0]?.name).toBe("noteGate");
    expect(ctx.waited).toEqual([retentionToken("s_1")]);
  });
});

describe("compensate — the saga port", () => {
  test("unwinds newest-first, which is the order acquisitions were stacked in", async () => {
    // `recapFlow` pushes with `unshift`, so the list is already newest-first and
    // this walks it forwards. A dependency acquired later has to come off first.
    const order: string[] = [];
    await compensate(
      [
        { label: "second", undo: async () => void order.push("second") },
        { label: "first", undo: async () => void order.push("first") },
      ],
      "because",
      createWorkflowCtx(),
    );
    expect(order).toEqual(["second", "first"]);
  });

  test("a failing undo does not stop the ones behind it", async () => {
    // Ported deliberately from Temporal's `compensate`, which swallows: the run
    // already failed for a reason the caller needs, and a second-order undo
    // failure must not replace it or strand the rest of the stack.
    const order: string[] = [];
    await expect(
      compensate(
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
        createWorkflowCtx(),
      ),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["fine"]);
  });

  test("does nothing at all when nothing was acquired", async () => {
    // The case where the FIRST step failed: there is nothing to reverse, and a
    // run that narrated an unwind it did not perform would be lying to the
    // caller reading its progress.
    await expect(
      compensate([], "nothing was acquired", createWorkflowCtx()),
    ).resolves.toBeUndefined();
  });
});
