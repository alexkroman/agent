// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the recap desk — the template that ports the Temporal workflow
 * patterns onto a voice call.
 *
 * Three tiers, and the line between them is what this file is careful about:
 *
 * - **The tools**, against a stubbed `ctx.workflows`. That is the honest way to
 *   unit-test a TOOL — what a tool owns is the call it makes, not what the run
 *   does afterwards — and
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
 *   replay or suspension, and could not.
 * - **`recapFlow` itself, durably.** The last block runs it on the real replay
 *   engine over an in-memory journal (`runWorkflow`,
 *   `@alexkroman1/aai-runtime/testing`), which this file used to say needed a
 *   built world. It is the tier that reaches this desk's two most expensive
 *   claims: that a resume does not re-transcribe, and that the RETENTION GATE's
 *   unanswered window deletes. `aai-cli`'s `dev-workflow.scenario.test.ts` is
 *   still the tier above it, with a project and a real queue.
 *
 * **The branch this file used to name as its biggest gap no longer exists.** It
 * was `recapFlow`'s `if (isWorkflowSuspend(err)) throw err;` — the guard whose
 * absence had once deleted the transcript the run was waiting for — and it was
 * unpinnable here by construction, since `createWorkflowCtx`'s `sleep` is
 * RECORDED and its `waitFor` answers out of `hooks`, so no wait it serves ever
 * suspended. A wait now hands the body a promise that never settles, so a
 * suspension cannot reach a `catch` at all and there is no branch left to test:
 * `aai-runtime`'s `workflow-replay-suspend.ts` carries the mechanism and
 * `workflow-replay.test.ts` the engine-level proof, for every template at once.
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
  stubGatewayRoute,
  toolRunner,
} from "@alexkroman1/aai/testing";
import {
  installStubStepFetch,
  installStubWorkflows,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { recap } from "./shared.ts";
import {
  askWhetherToKeep,
  awaitTranscript,
  callbackUrl,
  checkTranscript,
  compensate,
  discardTranscript,
  recapFlow,
  submitRecording,
  summarize,
  type TranscriptState,
} from "./workflows/recap.ts";
import { retentionToken, transcriptToken } from "./workflows/tokens.ts";

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
 * `installStubWorkflows` (`@alexkroman1/aai/testing/vitest`) is the whole thing — a
 * `vi.fn` per method over one `runs` list, with `stream`/`streamTail` left
 * rejecting because `recap_progress` reads progress through `lastLine` and
 * composing those two by hand is the hazard `lastLine` exists to remove. What
 * is local is only which workflow this desk declares.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  return installStubWorkflows({ runs, names: ["recap"] });
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
    // `toContain` rather than an exact key list: a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — this key is a STRING to everything
    // outside this file (the REST route, `ctx.workflows.get`, a schedule), so
    // renaming it is a runtime 404 rather than a compile error, and nothing
    // else says so.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("recap");
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
    // Discovered, not declared: every name here is a file in `tools/`. Asserted
    // with `arrayContaining`, because dropping a file into `tools/` is the
    // cheapest edit this template invites and an exact list would turn it into
    // a failing test in somebody else's project. What still fails is a tool
    // going MISSING — which is what a broken discovery looks like, and it looks
    // identical to a template that never had tools.
    expect(Object.keys(agentDef.tools)).toEqual(
      expect.arrayContaining([
        "cancel_recap",
        "keep_transcript",
        "recap_progress",
        "recap_status",
        "request_recap",
      ]),
    );
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
 * `discardTranscript` reach it directly, `stepTranscribeSubmitOrFail`
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
    // `callback: false` alongside the id, because the body may only branch on
    // journaled values — see `submitRecording`'s own doc. No minter is published
    // in a spec, so `stepWebhookUrl` throws and `callbackUrl` degrades.
    expect(await submitRecording("https://example.com/a.mp3")).toEqual({
      id: "t_1",
      callback: false,
    });

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

  test("asks the provider to CALL BACK when it was handed a URL to call", async () => {
    const calls = stubProvider({ id: "t_1", status: "queued" });
    await submitRecording("https://example.com/a.mp3", "https://desk.example/hook/transcript:s_1");

    // `webhook_url` rides the same `params` passthrough `speaker_labels` does.
    // This one field is the whole difference between the two arms of
    // `awaitTranscript`.
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      webhook_url: "https://desk.example/hook/transcript:s_1",
      speaker_labels: true,
    });
  });

  test("reports the callback FACT with the id, so the body branches on the journal", async () => {
    // The determinism requirement in one assertion. Whether a callback was
    // registered decides whether the body parks on a hook, and a body may only
    // branch on what came out of the journal — so the step that established the
    // fact is what returns it. A body that re-minted the URL on each replay
    // could flip this branch under a redeploy and then look for a `waitFor` the
    // journal never recorded.
    stubProvider({ id: "t_1", status: "queued" });
    expect(
      await submitRecording("https://example.com/a.mp3", "https://desk.example/hook/t"),
    ).toEqual({ id: "t_1", callback: true });
  });

  test("OMITS the key rather than sending a null when there is no callback URL", async () => {
    // `JSON.stringify` drops an `undefined` property, so the key is absent on
    // the wire for free — and what this pins is that nobody "makes it explicit"
    // with a `?? null` or a `?? ""`, either of which puts it back. A provider
    // handed a null for a URL is entitled to refuse the whole submission. The
    // assertion is about the KEY, which `toMatchObject` cannot express.
    const calls = stubProvider({ id: "t_1", status: "queued" });
    await submitRecording("https://example.com/a.mp3");

    expect(Object.keys(JSON.parse(String(calls[0]?.body)))).not.toContain("webhook_url");
  });
});

describe("callbackUrl", () => {
  test("degrades to NO callback when the deployment cannot mint one", async () => {
    // `stepWebhookUrl` THROWS on an unpublished slot rather than answering
    // `undefined` — a callback URL has no legitimate default, so the SDK refuses
    // to invent one. A spec publishes no minter, which is the same position as
    // `aai dev` on a laptop and a self-hosted server started without
    // `publicUrl`. What must NOT happen is that throw reaching the step: a recap
    // may not fail over a missing optimization.
    expect(callbackUrl(transcriptToken("s_1"))).toBeUndefined();
  });

  test("does not swallow an EMPTY token, which would compose the route's own prefix", async () => {
    // The one input `stepWebhookUrl` refuses that is a caller bug rather than a
    // deployment fact — and this pins that `callbackUrl`'s catch does not hide
    // it as "no callback available". A URL that is the bare prefix is refused by
    // the route's own parser, so the failure would otherwise arrive at the far
    // end as a 404 on a URL nobody can re-issue.
    //
    // It currently reads `undefined` because the unpublished slot is checked
    // FIRST, so both arms of `stepWebhookUrl` are indistinguishable here. That is
    // a real limit of this tier rather than a claim about the SDK: a spec with a
    // published minter would tell them apart, and publishing one needs
    // `publishStepWebhookUrl` off `@alexkroman1/aai/host-internal` — a host
    // surface a template has no business importing. Recorded so the next reader
    // does not mistake the assertion for a stronger one than it is.
    expect(callbackUrl("")).toBeUndefined();
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

  test("drops a field of the wrong type rather than failing the poll", async () => {
    // THE degradation rule, and the test that fails against a schema parsed
    // with a throwing `parse`: the job is running and `status` says so, so a
    // `text` the provider sent as a number is one unusable field — not a reason
    // to end a run that has already paid for the transcription. Each optional
    // field carries its own `.catch(undefined)` for exactly this.
    stubProvider({ status: "processing", text: 42, error: [], audio_duration: "254" });
    expect(await checkTranscript("t_1")).toEqual({ status: "processing" });
  });

  test("drops a non-finite duration, which `Math.round(x / 60)` cannot use", async () => {
    // JSON cannot spell `Infinity`, so this arrives as a string or a null and
    // has to be refused the same way — `z.number()` refuses both, which is the
    // `Number.isFinite` test the hand-written reader carried.
    stubProvider({ status: "completed", text: "Hello.", audio_duration: null });
    expect(await checkTranscript("t_1")).toEqual({ status: "completed", text: "Hello." });
  });

  test("names an unreadable body as `undefined` rather than throwing twice", async () => {
    // Valid JSON that is not this endpoint's object — a proxy that answered
    // with a list, say. There is no status to report, so the sentence says
    // exactly that rather than the report itself failing on the body it was
    // sent to describe.
    stubProvider([{ status: "completed" }]);
    await expect(checkTranscript("t_1")).rejects.toThrow(/unknown transcript status: undefined/);
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

describe("awaitTranscript — the polling port, and the callback over it", () => {
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

  /** A job still `processing` for `polls` turns, then completed. */
  function stubSlowJob(polls: number) {
    return stubStatuses([
      ...Array.from({ length: polls }, () => ({ status: "processing" })),
      { status: "completed", text: "Done.", audio_duration: 60 },
    ]);
  }

  test("says nothing about a long one until it really has waited two minutes", async () => {
    // The boundary this case and the next one hold together, and it is where
    // `PATIENCE_POLLS` disagreed with its own doc. The note goes out at the TOP
    // of a poll, so the wait it follows is the sleeps BEHIND it — attempt N is
    // reached after N-1 of them. At a fifteen-second interval the two minutes
    // the constant promises is eight sleeps, so the earliest honest turn to say
    // it is the ninth. Here the job finishes on that ninth poll, two minutes in
    // and not a second over, so the caller is told nothing.
    const ctx = createWorkflowCtx();
    stubSlowJob(8);

    await awaitTranscript("t_1", ctx);

    expect(ctx.steps.filter((entry) => entry.name === "noteSlow")).toEqual([]);
    // Eight sleeps of the declared interval — the two minutes, exactly.
    expect(ctx.slept.map((one) => one.until)).toEqual(Array.from({ length: 8 }, () => 15_000));
  });

  test("says it ONCE past two minutes, not on every poll after", async () => {
    // The ninth poll finds the job still going, which is the first turn that has
    // two minutes of waiting behind it — so the note goes out, and the eleven
    // polls after it say nothing more. A note per poll would be a caller told
    // the same sentence every fifteen seconds.
    const ctx = createWorkflowCtx();
    stubSlowJob(20);

    await awaitTranscript("t_1", ctx);

    expect(ctx.steps.filter((entry) => entry.name === "noteSlow")).toHaveLength(1);
  });

  // ---- The callback arm -----------------------------------------------------
  //
  // Everything above drives `awaitTranscript` with no callback token, which is
  // what a deployment that does not know its own public URL gets — and those
  // cases are the REGRESSION guard for this section: the poll-only arm has to
  // keep behaving exactly as it did before there was a callback at all.
  //
  // `createWorkflowCtx` is the only tier that can drive the answered branch:
  // its `waitFor` reads `hooks` by token, so supplying a payload IS the delivery
  // landing and omitting one IS the window closing. The eval tier cannot —
  // nothing there can signal — so it only ever sees the fallback, which is
  // stated in `agent.eval.test.ts`.

  /** The token both `request_recap` and the body derive for one session. */
  const NUDGE = transcriptToken("s_1");

  test("the delivery ends the wait, so a finished job costs no sleeping at all", async () => {
    // The whole point of the conversion, in one assertion. Read once, park on
    // the callback, read again when it lands: two requests to the provider
    // where the poll-only arm would have made nine before it even said
    // anything, and not one durable sleep.
    const polls = stubStatuses([
      { status: "processing" },
      { status: "completed", text: "Done.", audio_duration: 60 },
    ]);
    const ctx = createWorkflowCtx({
      hooks: { [NUDGE]: { transcript_id: "t_1", status: "completed" } },
    });

    const state = await awaitTranscript("t_1", ctx, NUDGE);

    expect(state).toMatchObject({ status: "completed", text: "Done." });
    expect(polls()).toBe(2);
    expect(ctx.slept).toEqual([]);
    // On the token the tool derives for the same session — the one string this
    // template and a third party on the public internet have to agree about.
    expect(ctx.waited).toEqual([NUDGE]);
  });

  test("a delivery is a NUDGE, not an answer: the run still READS the status", async () => {
    // The security property of this template, and the reason an unauthenticated
    // callback route is safe here. The payload SAYS the job completed; the
    // provider's own endpoint says otherwise, and the provider wins — so a
    // forged delivery on a guessed token costs exactly one extra read and
    // changes no outcome. Nothing the payload carries is ever read.
    const polls = stubStatuses([
      { status: "processing" },
      { status: "processing" },
      { status: "completed", text: "The real transcript.", audio_duration: 60 },
    ]);
    const ctx = createWorkflowCtx({
      hooks: { [NUDGE]: { transcript_id: "t_1", status: "completed", text: "A LIE." } },
    });

    const state = await awaitTranscript("t_1", ctx, NUDGE);

    expect(state).toMatchObject({ status: "completed", text: "The real transcript." });
    // Three reads: the one before the park, the one the delivery woke, and the
    // one after the ordinary fifteen-second wait that followed it.
    expect(polls()).toBe(3);
    expect(ctx.slept).toEqual([{ label: "poll", until: 15_000, correlationId: undefined }]);
  });

  test("parks ONCE and then polls, because a token cannot be claimed twice", async () => {
    // `claimHook` refuses a second claim on a token its run still holds, and a
    // refusal is a throw rather than a suspend — which `recapFlow`'s catch would
    // read as a failed run and answer by deleting the transcript. So the wait
    // may not be inside the loop, and this is what pins that: twenty turns, ONE
    // `waitFor`, and every other wait a plain sleep.
    const ctx = createWorkflowCtx({ hooks: { [NUDGE]: {} } });
    stubSlowJob(20);

    await awaitTranscript("t_1", ctx, NUDGE);

    expect(ctx.waited).toHaveLength(1);
    expect(ctx.slept).toHaveLength(19);
  });

  test("an unanswered window falls back to the poll rather than hanging", async () => {
    // No `hooks` entry, so the timed wait resolves `undefined` — which IS the
    // window closing. The run must finish anyway: a dropped delivery is the
    // ordinary case a webhook has no answer for, and a template that waited
    // forever on one would be strictly worse than the loop it replaced.
    const polls = stubStatuses([
      { status: "processing" },
      { status: "processing" },
      { status: "completed", text: "Done.", audio_duration: 60 },
    ]);
    const ctx = createWorkflowCtx();

    const state = await awaitTranscript("t_1", ctx, NUDGE);

    expect(state).toMatchObject({ status: "completed", text: "Done." });
    expect(polls()).toBe(3);
    // It asked, and then it stopped counting on the answer.
    expect(ctx.waited).toEqual([NUDGE]);
    expect(ctx.slept).toEqual([{ label: "poll", until: 15_000, correlationId: undefined }]);
  });

  test("says 'still transcribing' after ONE closed window, not after nine", async () => {
    // The same two minutes the poll-only arm counts out in eight sleeps, in one
    // window — so whichever arm a run is on, a caller hears the sentence at the
    // same point. The note goes out at the TOP of a poll, so attempt 2 is the
    // first turn with a whole closed window behind it.
    const ctx = createWorkflowCtx();
    stubSlowJob(20);

    await awaitTranscript("t_1", ctx, NUDGE);

    const notes = ctx.steps.filter((entry) => entry.name === "noteSlow");
    expect(notes).toHaveLength(1);
    // Attempt 2, which is one `checkTranscript` and one closed window in.
    expect(ctx.steps.slice(0, 3).map((entry) => entry.name)).toEqual([
      "checkTranscript",
      "checkTranscript",
      "noteSlow",
    ]);
  });

  test("says nothing when the delivery beats the window", async () => {
    // The mirror of the case above, and what stops the note being a thing every
    // callback run says: the delivery lands, attempt 2 finds the job done, and
    // nobody is told a recording is a long one.
    const ctx = createWorkflowCtx({ hooks: { [NUDGE]: {} } });
    stubSlowJob(1);

    await awaitTranscript("t_1", ctx, NUDGE);

    expect(ctx.steps.filter((entry) => entry.name === "noteSlow")).toEqual([]);
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

/**
 * `recapFlow` itself, on the real replay engine.
 *
 * `runWorkflow` starts the declared workflow on `createInProcessWorkflowEngine`
 * over an in-memory journal and drives one delivery at a time, with a suspension
 * RECORDED rather than waited out. So the poll cadence a deployed run spends
 * fifteen seconds a turn on costs this file nothing, and the run really parks,
 * really resumes off its journal, and really closes its window.
 *
 * Two of this desk's claims are only reachable here, and both are expensive when
 * wrong:
 *
 * - **A resume does not re-transcribe.** Twenty minutes of provider time is
 *   already paid for, which is why `summarize` is its own step; nothing below
 *   this tier can show that a second walk did not submit the recording again.
 * - **The retention gate's unanswered window DELETES.** "A gate whose no-answer
 *   branch keeps the data is not a gate", and for a desk holding transcripts of
 *   other people's meetings the default is what the whole pattern is about.
 *   `ctx.workflows.wakeUp` deliberately cannot end an approval window — that is
 *   `SleepRecord.kind`'s entire reason — so `expireWaits()` is the only thing
 *   that reaches the branch.
 *
 * Note the body takes the POLL arm throughout: `callbackUrl` degrades to
 * `undefined` in a spec (no minter is published), so `job.callback` is `false`
 * and the first-turn callback park is never entered. That is the same arm a
 * local `aai dev` run takes, and its own doc says so.
 */
describe("the run is DURABLE", () => {
  const URL = "https://example.com/standup.mp3";
  const INPUT = { url: URL, requestedBy: "sess_1" };
  const RECAP = '{"headline":"Standup","points":["a","b"],"spoken":"They shipped it."}';

  /**
   * The provider and the model, behind ONE published `stepFetch`.
   *
   * Every step's HTTP goes through the slot, the model call included, so a
   * gateway stub installed over `globalThis.fetch` beside a provider stub would
   * be bypassed — `link-digest/agent.test.ts` carries the same note.
   * `stubGatewayRoute` is the composition for it.
   *
   * `transcript` is a list of successive `GET` answers, so a spec says how many
   * polls the job takes by how many entries it gives.
   */
  function stubWorld(transcript: readonly Record<string, unknown>[]) {
    const model = stubGatewayRoute(RECAP);
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
      // The last answer repeats, so a spec that wants one more poll than it
      // scripted gets the terminal state rather than an index error.
      const at = Math.min(polls++, transcript.length - 1);
      return { status: 200, body: transcript[at] ?? {} };
    });
    return { model, deletes, provider, polls: () => polls };
  }

  const PROCESSING = { id: "t_1", status: "processing" };
  const DONE = {
    id: "t_1",
    status: "completed",
    text: "We shipped it.",
    audio_duration: 600,
  };

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("submits once, then parks on the poll cadence rather than blocking", async () => {
    stubWorld([PROCESSING, DONE]);
    const started = Date.now();
    const run = await runWorkflow(recap, INPUT, { name: "recap" });

    expect(run.status).toBe("running");
    // The 15s poll interval, journaled — the run is in progress and not
    // executing, which is what a caller polling it sees.
    expect(run.wakeAt).toBeGreaterThan(started);
    expect(run.steps.map((step) => step.key)).toEqual(["checkTranscript#0", "submitRecording#0"]);
  });

  test("resumes past the poll WITHOUT re-submitting the recording", async () => {
    // The claim `summarize` is a separate step for: twenty minutes of provider
    // time is already paid for, and a resume must not spend it again.
    const world = stubWorld([PROCESSING, DONE]);
    const run = await runWorkflow(recap, INPUT, { name: "recap" });
    await run.advanceSleep();

    // Parked again, now on the retention gate — a hook with a deadline.
    expect(run.status).toBe("running");
    expect(run.steps.map((step) => step.key)).toEqual([
      "checkTranscript#0",
      "checkTranscript#1",
      "noteGate#0",
      "submitRecording#0",
      "summarize#0",
    ]);
    expect(run.deliveries).toBe(2);
    // ONE submit across two walks — `submitRecording#0` came back out of the
    // journal on the second — and one model call.
    expect(
      world.provider.calls.filter((call) => call.method === "POST" && !call.url.includes("chat")),
    ).toHaveLength(1);
    expect(world.model.calls).toHaveLength(1);
  });

  test("an answer of KEEP leaves the transcript on the account", async () => {
    const world = stubWorld([DONE]);
    const run = await runWorkflow(recap, INPUT, { name: "recap" });
    await run.signal(retentionToken("sess_1"), { keep: true });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ kept: true, answered: true, requestedBy: "sess_1" });
    // No discard step reached at all, and nothing deleted.
    expect(run.steps.map((step) => step.name)).not.toContain("discardOnDecline");
    expect(world.deletes).toEqual([]);
  });

  test("an UNANSWERED window deletes, which is the safe default the gate exists for", async () => {
    // The branch nothing else can reach: `ctx.workflows.wakeUp` must not close
    // an approval window, and the deadline carries no correlation id, so the
    // only public route to this outcome is to wait out two real minutes.
    const world = stubWorld([DONE]);
    const run = await runWorkflow(recap, INPUT, { name: "recap" });
    expect(run.status).toBe("running");

    await run.expireWaits();
    expect(run.status).toBe("completed");
    // `answered: false` is the distinction the type carries: the caller did not
    // decline, they said nothing, and the desk deleted anyway.
    expect(run.output).toMatchObject({ kept: false, answered: false });
    expect(run.steps.map((step) => step.name)).toContain("discardOnDecline");
    expect(world.deletes).toHaveLength(1);
    expect(world.deletes[0]).toContain("t_1");
  });

  test("a signal that arrives after the window closed cannot reopen it", async () => {
    // `closeHook` is a compare-and-set, so the walk that timed out and every
    // later replay read the same branch — the divergence `HookRecord.closed`
    // exists to prevent.
    stubWorld([DONE]);
    const run = await runWorkflow(recap, INPUT, { name: "recap" });
    await run.expireWaits();
    expect(run.output).toMatchObject({ kept: false });

    await run.signal(retentionToken("sess_1"), { keep: true });
    expect(run.signalled).toBe(false);
    expect(run.output).toMatchObject({ kept: false });
  });

  test("a failure after the transcript exists UNWINDS it, and the run still fails", async () => {
    // The saga. `summarize` is given prose instead of JSON on every attempt, so
    // the step exhausts its patience and the body's catch runs the compensation
    // stack — which must delete the transcript the run acquired.
    const model = stubGatewayRoute("Here is a recap, in prose, as you did not ask.");
    const deletes: string[] = [];
    installStubStepFetch((request) => {
      const routed = model.route(request);
      if (routed) return routed;
      if (request.method === "DELETE") {
        deletes.push(request.url);
        return { status: 200, body: {} };
      }
      if (request.method === "POST") return { status: 200, body: { id: "t_1", status: "queued" } };
      return { status: 200, body: DONE };
    });

    const run = await runWorkflow(recap, INPUT, { name: "recap" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/JSON/i);
    // The undo ran, as a STEP — which is what makes a crash during the unwind
    // resume with the finished ones replayed rather than run twice.
    expect(run.steps.map((step) => step.name)).toContain("discardTranscript");
    expect(deletes).toHaveLength(1);
  });
});
