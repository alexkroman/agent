// Copyright 2026 the AAI authors. MIT license.

/**
 * The WORKFLOW half of the research desk: its steps, what it files, and the run
 * itself.
 *
 * `agent.test.ts` beside this file drives the four TOOLS against a stubbed
 * `ctx.workflows`. Nothing here has a `ToolContext` at all, which is the split:
 * a step is an ordinary exported async function, so its prompt handling, its
 * parsing and its `FatalError` guards are all testable without an engine — and
 * the BODY is driven twice, once through `createWorkflowContext`, which records
 * what it asked for and replays nothing, and once on the REAL replay engine.
 *
 * `runWorkflow` from `@alexkroman1/aai-runtime/testing` is that second one, and
 * it is what makes the desk's promise — **answer the caller now, finish the work
 * later** — an assertion rather than a claim: the review wait really suspends,
 * the resume really comes off the journal, and this file reads that journal
 * directly for the three things the run's own snapshot cannot show (which sleep
 * is open and under what name, what an `investigate` left behind for a resume to
 * reuse, and whether a boot sweep would still find a run whose worker died).
 * `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier above both, with a
 * built project and a real queue.
 */

import { DEFAULT_STEP_MAX_ATTEMPTS } from "@alexkroman1/aai";
import { renderSlackPlainText } from "@alexkroman1/aai/channels";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import {
  createToolContext,
  createWorkflowContext,
  type StubDelegateCall,
  type StubGatewayCall,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
} from "@alexkroman1/aai/testing";
import {
  installStubReporter,
  installStubStepDelegate,
  installStubStepFetch,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import type {
  JournalStore,
  ResumableRun,
  SleepRecord,
  StepEntry,
  WorkflowTestHandle,
  WorkflowTestRun,
} from "@alexkroman1/aai-runtime/testing";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { research } from "./shared.ts";
import {
  file,
  FILING_TEXT_PARAM_ENV,
  FILING_WEBHOOK_ENV,
  type Filing,
  filingChannel,
  renderFiling,
} from "./workflows/filing.ts";
import {
  countSources,
  dedupe,
  findGaps,
  investigate,
  planAngles,
  researchFlow,
  writeBrief,
  writeReport,
} from "./workflows/research.ts";
import { REVIEW_DELAY_MS, REVIEW_SLEEP_ID } from "./workflows/review.ts";

describe("the pure helpers", () => {
  test("dedupe keeps the first occurrence of each URL", () => {
    const sources = [
      { title: "One", url: "https://a.example" },
      { title: "One again", url: "https://a.example" },
      { title: "Two", url: "https://b.example" },
    ];
    expect(dedupe(sources)).toEqual([sources[0], sources[2]]);
  });

  test("countSources counts DISTINCT sources across every angle", () => {
    // What the voice agent quotes. Two researchers finding the same page is one
    // source, and reporting two would overstate the research.
    const shared = { title: "Shared", url: "https://a.example" };
    expect(
      countSources([
        { angle: "one", findings: "…", sources: [shared, { title: "B", url: "https://b" }] },
        { angle: "two", findings: "…", sources: [shared] },
      ]),
    ).toBe(2);
  });
});

describe("the steps that research", () => {
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is. `unstubEnvs` clears it per test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /**
   * The SDK's fake gateway, installed.
   *
   * The fake itself is `@alexkroman1/aai/testing`'s — it answers a QUEUE of
   * completions, repeating the last, which is what a spec needs for a loop that
   * is a CONVERSATION (search, then read, then stop) rather than one call. What
   * stays here is the INSTALLATION, because the lifetime of a global stub is
   * vitest's business and the SDK helper deliberately carries no test-runner
   * dependency.
   */

  /** The prompt the Nth model call carried. */
  function promptOf(calls: readonly StubGatewayCall[], at: number): string {
    return calls[at]?.prompt ?? "";
  }

  const brief = { brief: "How otters use tools", criteria: ["Which species", "How it is learned"] };

  test("writeBrief turns a spoken request into a brief and its criteria", async () => {
    const calls = stubGateway([
      JSON.stringify({ brief: "How otters use tools", criteria: ["Which species"] }),
    ]);
    expect(await writeBrief("otters")).toEqual({
      brief: "How otters use tools",
      criteria: ["Which species"],
    });
    expect(promptOf(calls, 0)).toContain("otters");
  });

  test("writeBrief falls back to the topic rather than filing an empty brief", async () => {
    // The caller said something; a model that returns no brief must not erase it.
    stubGateway([JSON.stringify({ criteria: [] })]);
    expect(await writeBrief("otters")).toEqual({ brief: "otters", criteria: [] });
  });

  test("planAngles asks the model for the fan-out's width", async () => {
    const calls = stubGateway([JSON.stringify({ angles: ["Tool use", "Which species"] })]);
    expect(await planAngles(brief)).toEqual(["Tool use", "Which species"]);
    // The angles are measured against the brief, so the criteria travel with it.
    expect(promptOf(calls, 0)).toContain("Which species");
  });

  test("planAngles researches the brief itself when no angles come back", async () => {
    // Nothing to fan out over is a plan failure, not an empty result — and the
    // brief is the one angle that is always available.
    stubGateway([JSON.stringify({ angles: [] })]);
    expect(await planAngles(brief)).toEqual([brief.brief]);
  });

  test("investigate hands the angle to a subagent, with the brief as its context", async () => {
    const desk = installStubStepDelegate({ researcher: "Sea otters crack shellfish [1]." });

    const note = await investigate(brief, "Tool use");

    expect(note.findings).toBe("Sea otters crack shellfish [1].");
    expect(desk.calls).toHaveLength(1);
    // The angle is the TASK and the brief rides in `context`: a subagent has not
    // heard the call and cannot see its siblings, so an angle handed over on its
    // own gets a confident answer about the wrong question.
    expect(desk.calls[0]?.task).toBe("Tool use");
    expect(desk.calls[0]?.options.context).toContain("How otters use tools");
  });

  test("the researcher is given the web builtins, the budget, and what to answer with", async () => {
    // What this template still OWNS, now that the loop is the runtime's: which
    // capabilities the angle is worth, and what a finding has to be.
    const desk = installStubStepDelegate({ researcher: "found things" });
    await investigate(brief, "Tool use");

    const researcher = desk.calls[0]?.subagent;
    expect(researcher?.builtinTools).toEqual(["web_search", "visit_webpage"]);
    expect(researcher?.maxSteps).toBe(6);
    expect(researcher?.expectedOutput).toContain("repeat");
    expect(Object.keys(researcher?.tools ?? {})).toEqual(["cite"]);
  });

  test("sources are what the researcher CITED", async () => {
    const desk = installStubStepDelegate({
      // The runtime runs a subagent's tools; the stub does not, so the route
      // calls `cite` the way a real run would. It is an ordinary `ToolDef`, which
      // is what makes that possible at all.
      researcher: (call: StubDelegateCall) => {
        void call.subagent.tools?.cite?.execute(
          { title: "Otters", url: "https://otters.example/tools" },
          createToolContext(),
        );
        return "Sea otters crack shellfish [1].";
      },
    });

    const note = await investigate(brief, "Tool use");

    expect(note.sources).toEqual([{ title: "Otters", url: "https://otters.example/tools" }]);
    expect(desk.calls).toHaveLength(1);
  });

  test("a researcher that never cited falls back to the pages it OPENED", async () => {
    // The worse of the two failures is a note full of findings reporting no
    // sources at all — the report stage cites from this list.
    installStubStepDelegate({
      researcher: {
        text: "Sea otters crack shellfish.",
        toolCalls: [
          { name: "web_search", input: { query: "otter tool use" } },
          { name: "visit_webpage", input: { url: "https://otters.example/tools" } },
          { name: "visit_webpage", input: { url: "https://otters.example/tools" } },
        ],
      },
    });

    const note = await investigate(brief, "Tool use");

    expect(note.sources).toEqual([
      { title: "https://otters.example/tools", url: "https://otters.example/tools" },
    ]);
  });

  test("investigate reports what the angle cost, since the searches are not visible here", async () => {
    const reported = installStubReporter();
    installStubStepDelegate({
      researcher: {
        text: "found things",
        toolCalls: [
          { name: "web_search", input: { query: "a" } },
          { name: "web_search", input: { query: "b" } },
          { name: "visit_webpage", input: { url: "https://otters.example/tools" } },
        ],
      },
    });

    await investigate(brief, "Tool use");

    // Coarser than the per-search line it replaces, and deliberately — see
    // `investigate`. What a listener needs is that an angle is moving.
    expect(reported.lines.join("\n")).toContain("Looking into: Tool use");
    expect(reported.lines.join("\n")).toContain("2 searches, 1 page read");
  });

  test("both investigate waves are called with more attempts than the default", async () => {
    // The retry policy is an argument to `ctx.step` now rather than a
    // `maxRetries` property, so it is observable only at the CALL — and there
    // are two calls, one per wave, which is exactly the kind of thing a property
    // could not have said differently.
    // `planAngles`' result is what the fan-out iterates, so it is supplied
    // rather than run — the rest of the body needs no page and no model.
    const ctx = createWorkflowContext({
      runSteps: false,
      // Every step the body READS needs a value: with `runSteps: false` nothing
      // runs, so this is the skeleton of a run rather than a run. That is the
      // trade — no page, no model and no search, in exchange for spelling the
      // shape out.
      results: {
        planAngles: ["Adoption", "Tooling"],
        findGaps: ["Cost"],
        investigate: { angle: "Adoption", findings: "f", sources: [] },
        investigateGap: { angle: "Cost", findings: "f", sources: [] },
        writeReport: { summary: "s", report: "r" },
      },
    });
    await researchFlow({ topic: "Tool use", requestedBy: "Ada" }, ctx);

    const investigations = ctx.steps.filter((step) => step.name.startsWith("investigate"));
    expect(investigations.length).toBeGreaterThan(0);
    // Against the SDK's own default rather than the literal 3 this used to
    // carry: what the claim is about is that an angle gets more than an
    // ordinary step, and a default that moved would have left the old number
    // asserting something nobody meant.
    for (const step of investigations) {
      expect(step.maxAttempts).toBeGreaterThan(DEFAULT_STEP_MAX_ATTEMPTS);
    }
  });

  test("the review wait is opened under the name file_it_now wakes", async () => {
    // The two halves of one agreement, and the only place a spec can see both:
    // the body's `correlationId` here, and the tool's `correlationIds` in
    // `agent.test.ts`. `review.ts` is the module that keeps them equal.
    const ctx = createWorkflowContext({
      runSteps: false,
      results: {
        planAngles: ["Adoption"],
        findGaps: [],
        investigate: { angle: "Adoption", findings: "f", sources: [] },
        writeReport: { summary: "s", report: "r" },
      },
    });
    await researchFlow({ topic: "Tool use", requestedBy: "Ada" }, ctx);

    expect(ctx.sleeps).toHaveLength(1);
    expect(ctx.sleeps[0]?.options?.correlationId).toBe(REVIEW_SLEEP_ID);
  });

  // Driven through `writeBrief` rather than `investigate`: the classification is
  // `stepGenerateJsonOrFail`'s and every JSON stage shares it, and `investigate`
  // stopped being one of them when its loop became a subagent's.
  test("a rate limit is RETRYABLE, so the engine tries again", async () => {
    // The message alone cannot say this — a 429 and a 401 read alike — so what
    // is asserted is the class the engine actually branches on.
    stubGateway([""], { status: 429 });
    const err = await writeBrief("otters").catch((thrown: unknown) => thrown);
    expect(RetryableError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/HTTP 429/);
  });

  test("a rejected request is FATAL rather than retried five times", async () => {
    stubGateway([""], { status: 401 });
    const err = await writeBrief("otters").catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/HTTP 401/);
  });

  test("a missing key is FATAL, naming the key", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway(["anything"]);
    const err = await writeBrief("otters").catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/ASSEMBLYAI_API_KEY/);
  });

  test("a reply that is not JSON throws plainly, because a retry may well obey", async () => {
    stubGateway(["I would rather write you an essay."]);
    await expect(writeBrief("otters")).rejects.toThrow(/Expected JSON/);
  });

  test("findGaps asks nothing when the first wave found nothing", async () => {
    const calls = stubGateway([JSON.stringify({ angles: ["anything"] })]);
    expect(await findGaps(brief, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("findGaps names what is still unanswered against the criteria", async () => {
    const calls = stubGateway([JSON.stringify({ angles: ["How it is learned"] })]);
    const gaps = await findGaps(brief, [
      { angle: "Tool use", findings: "They use stones.", sources: [] },
    ]);
    expect(gaps).toEqual(["How it is learned"]);
    expect(promptOf(calls, 0)).toContain("They use stones.");
  });

  test("writeReport writes the report AND the sentence a phone can carry", async () => {
    // Two model calls in ONE step, because they are one decision: a resume must
    // never pair a new summary with an old report.
    const calls = stubGateway(["# Otters\n\nThey use stones [1].", "Otters use stones as tools."]);
    const written = await writeReport("otters", brief, [
      { angle: "Tool use", findings: "They use stones.", sources: [] },
    ]);

    expect(written.report).toContain("# Otters");
    expect(written.summary).toBe("Otters use stones as tools.");
    expect(calls).toHaveLength(2);
    // Nothing researched is dropped on the way in.
    expect(promptOf(calls, 0)).toContain("They use stones.");
    // …and the summary is a reduction OF the report, not a second pass at the
    // findings — which is what keeps it consistent with what a page renders.
    expect(promptOf(calls, 1)).toContain("# Otters");
  });

  test("an empty completion throws rather than filing a blank report", async () => {
    stubGateway([""]);
    await expect(
      writeReport("otters", brief, [{ angle: "a", findings: "b", sources: [] }]),
    ).rejects.toThrow(/empty completion/);
  });
});

/**
 * The last step, which used to be a promise.
 *
 * What is asserted here is this template's half — what a filed report SAYS, and
 * that the channel is resolved from the env rather than assumed. The 4xx/5xx
 * split, the Block Kit assembly and the mrkdwn escaping are
 * `@alexkroman1/aai/channels`' and have their own specs; a template asserting
 * them again would pin the SDK's rendering from the outside.
 */
describe("filing the findings", () => {
  const WEBHOOK = "https://hooks.slack.com/services/T000/B000/abc";
  const TRIGGER = "https://hooks.slack.com/triggers/T000/B000/abc";

  const FILING: Filing = {
    topic: "how otters use tools",
    requestedBy: "sess_1",
    summary: "Sea otters use stones to crack shellfish, and the habit is learned.",
    angles: [
      {
        angle: "Tool use",
        sources: [{ title: "Otters and stones", url: "https://otters.example/tools" }],
      },
    ],
  };

  /**
   * The webhook, answered without a network.
   *
   * `installStubStepFetch` rather than a `fetch` global stub: a channel post
   * goes out through the published `stepFetch` slot like every other step
   * request, and stubbing the global would test a path production does not
   * take. Anything that is not the webhook is a finding rather than a 200 —
   * an unexpected request answered emptily reads to the run as a refusal.
   */
  function stubPost(answer: StubStepAnswer): StubStepFetch {
    return installStubStepFetch((request: StubStepRequest): StubStepAnswer => {
      if (!request.url.startsWith("https://hooks.slack.com/")) {
        throw new Error(`unexpected step request: ${request.method} ${request.url}`);
      }
      return answer;
    });
  }

  test("posts the summary and its sources to the configured webhook", async () => {
    vi.stubEnv(FILING_WEBHOOK_ENV, WEBHOOK);
    const posted = stubPost({ body: "ok" });

    const filedAt = await file(FILING);

    expect(posted.calls[0]?.method).toBe("POST");
    expect(posted.calls[0]?.url).toBe(WEBHOOK);
    expect(String(posted.calls[0]?.body)).toContain("crack shellfish");
    // `filedAt` is a TIME now. It was the literal string "filed" under a field
    // named for a timestamp, which was two claims and neither was true.
    expect(Number.isNaN(Date.parse(filedAt))).toBe(false);
  });

  test("with no webhook it files nowhere, says so, and does not fail the run", async () => {
    // The last step of a five-minute pass is the worst place to discover a
    // missing credential, so the channel is optional by construction — this is
    // the arm that keeps `aai dev` runnable before anything is configured.
    const reported = installStubReporter();
    const posted = stubPost({ body: "ok" });

    const filedAt = await file(FILING);

    expect(posted.calls).toEqual([]);
    expect(reported.lines.join("\n")).toContain(FILING_WEBHOOK_ENV);
    expect(Number.isNaN(Date.parse(filedAt))).toBe(false);
  });

  test("no webhook is NO CHANNEL, rather than a channel that cannot post", () => {
    expect(filingChannel()).toBeUndefined();
  });

  test("a text param is carried only where it means something", () => {
    // It names a Slack WORKFLOW variable, so it does something on a trigger URL
    // and quietly nothing on an incoming webhook — and a setting that looks
    // configured and is ignored is the worse of the two.
    vi.stubEnv(FILING_TEXT_PARAM_ENV, "report");
    vi.stubEnv(FILING_WEBHOOK_ENV, WEBHOOK);
    expect(filingChannel()?.options.textParam).toBeUndefined();

    vi.stubEnv(FILING_WEBHOOK_ENV, TRIGGER);
    expect(filingChannel()?.options.textParam).toBe("report");
  });

  test("names each angle and what was actually read under it", () => {
    const message = renderFiling(FILING);

    expect(message.heading).toBe("Research: how otters use tools");
    expect(message.subtitle).toContain("Requested by sess_1");
    expect(message.subtitle).toContain("1 source across 1 angle");
    expect(message.sections).toHaveLength(1);
    expect(message.sections?.[0]).toMatchObject({
      title: "Tool use",
      bullets: ["Otters and stones — https://otters.example/tools"],
    });
  });

  test("the message still answers where a destination renders no sections", () => {
    // A Slack workflow trigger takes ONE string, so the SDK folds the whole
    // message down to text — `renderSlackPlainText` is that folding. What has to
    // survive it is the answer and the sources, which is what a reader who never
    // opens the run gets.
    const flat = renderSlackPlainText(renderFiling(FILING));

    expect(flat).toContain("crack shellfish");
    expect(flat).toContain("https://otters.example/tools");
  });
});

/**
 * `researchFlow` itself, on the real replay engine.
 *
 * The block above drives this body through `createWorkflowContext`, which records
 * what it ASKED for and replays nothing — right for the retry policy and the
 * step order, and silent about the desk's actual promise: **answer the caller
 * now, finish the work later**. `runWorkflow`
 * (`@alexkroman1/aai-runtime/testing`) is the engine `aai dev` runs, over an
 * in-memory journal, so the review wait really suspends and the resume really
 * comes off the journal.
 *
 * The model is scripted POSITIONALLY, which is only safe because the run is made
 * sequential: one angle, and a researcher that stops on its first turn, so the
 * `mapConcurrent` fan-out has a single item and nothing races. A case that wants
 * two angles at once wants a router keyed on the system prompt instead — the
 * shape `link-digest` uses — because the order two concurrent step bodies reach
 * the gateway in is the scheduler's business.
 *
 * Five calls make a whole run: the brief, the angles, the researcher's first
 * action, the gap pass, and the report — plus its summary, which is a second
 * call on the same step.
 */
describe("the run is DURABLE", () => {
  const SCRIPT = [
    // writeBrief
    JSON.stringify({ brief: "How otters use tools", criteria: ["Which species"] }),
    // planAngles — ONE, so the fan-out is sequential and the script positional.
    JSON.stringify({ angles: ["Tool use"] }),
    // `investigate` is NOT in this script any more: it delegates, so its model
    // calls are the subagent's and are answered by `installStubStepDelegate`
    // below rather than by the gateway.
    // findGaps — none, so there is no second wave.
    JSON.stringify({ angles: [] }),
    // writeReport, then its summary.
    "The report about otters.",
    "Otters use tools.",
  ];
  const INPUT = { topic: "otters", requestedBy: "sess_1" };

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // No `RESEARCH_SLACK_WEBHOOK_URL`, so the filing step posts nothing — which
    // is why the gateway counts below are the run's model calls and only those.
    installStubStepDelegate({ researcher: "Nothing was found on this angle." });
  });

  /** The step keys a run journaled — the same shape three cases assert on. */
  function stepKeys(run: WorkflowTestRun<unknown>): string[] {
    return run.steps.map((step) => step.key);
  }

  /**
   * The one suspension a research run takes, read off the journal itself.
   *
   * The run's snapshot carries `wakeAt` and nothing about WHICH wait it is, so
   * the correlation id `file_it_now` names is only visible here.
   */
  async function reviewSleep(run: WorkflowTestHandle<unknown>): Promise<SleepRecord | undefined> {
    const sleeps = await run.journal.readSleeps(run.runId);
    return sleeps.find((sleep) => sleep.correlationId === REVIEW_SLEEP_ID);
  }

  /** What an `investigate` left in the journal for a resume to reuse. */
  async function journaledResearch(
    journal: JournalStore,
    runId: string,
  ): Promise<StepEntry | undefined> {
    return (await journal.readSteps(runId)).find((step) => step.name === "investigate");
  }

  /** What a boot sweep would still owe — the query a stranded run is found by. */
  async function resumable(journal: JournalStore): Promise<ResumableRun[]> {
    return (await journal.resumableRuns?.(10)) ?? [];
  }

  test("suspends on the review wait with the whole report already journaled", async () => {
    const started = Date.now();
    const model = stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });

    // Not blocked — suspended. The sandbox is free here, which is the whole
    // reason a caller can hang up.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(started + REVIEW_DELAY_MS);
    // Everything except the filing is durable already, and `file` has not run.
    expect(stepKeys(run)).toEqual([
      "findGaps#0",
      "investigate#0",
      "planAngles#0",
      "writeBrief#0",
      "writeReport#0",
    ]);
    // FIVE gateway calls for six steps, and the missing one is `investigate`:
    // its model turns belong to the subagent now and go through the delegate
    // slot instead. The STEP is still journaled — it is in the list above.
    expect(model).toHaveLength(5);
  });

  test("the open wait is the REVIEW wait, by the name the tool wakes", async () => {
    stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });

    const sleep = await reviewSleep(run);
    expect(sleep, "the run holds no sleep under the review correlation id").toBeDefined();
    expect(sleep?.woken).toBe(false);
    expect(sleep?.kind).toBe("sleep");
  });

  test("makes no decision a replay could not reproduce", async () => {
    // `reads` records every `ctx.now`/`ctx.random`/`ctx.uuid` the body took, and
    // this body takes none: the fan-out's width comes from a journaled step, and
    // the filing timestamp is a step RESULT. An empty list is the determinism
    // rule this template's doc states, asserted rather than described.
    stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });

    expect(run.reads).toEqual([]);
  });

  test("resumes past the review wait and files, without researching again", async () => {
    const model = stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });
    // `advanceSleep` is `ctx.workflows.wakeUp`'s own mechanism, which is what
    // the `file_it_now` tool calls to cut the review short — and it is given the
    // SAME correlation id that tool passes, so what this drives is that tool's
    // effect rather than a blanket wake nothing in the desk performs.
    await run.advanceSleep([REVIEW_SLEEP_ID]);

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      topic: "otters",
      summary: "Otters use tools.",
      report: "The report about otters.",
      angles: ["Tool use"],
    });
    // A real timestamp, and the filing step really ran.
    expect(Number.isNaN(Date.parse(run.output?.filedAt ?? ""))).toBe(false);
    expect(run.deliveries).toBe(2);
    // The second walk re-entered the body from the top and paid the model
    // NOTHING: every step above the wait came back out of the journal.
    expect(model).toHaveLength(5);
  });

  test("a worker that dies at the report replays the research rather than repeating it", async () => {
    // The expensive claim. A deep-research pass is five to twelve model calls
    // and as many searches; a resume that redid them would cost the run twice.
    const model = stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, {
      name: "research",
      crashAt: "writeReport",
    });

    expect(run.crashed).toBe(true);
    expect(stepKeys(run)).toEqual(["findGaps#0", "investigate#0", "planAngles#0", "writeBrief#0"]);
    // THREE, not four: `investigate` is one of the four steps above and paid
    // the gateway nothing — its turns went to the subagent.
    const spentBeforeTheCrash = model.length;
    expect(spentBeforeTheCrash).toBe(3);

    // WHY the resume is free, read off the store rather than inferred from a
    // call count: the finished angle's own result is sitting in the journal,
    // which is what the second walk answers `investigate#0` from.
    const done = await journaledResearch(run.journal, run.runId);
    expect(done?.status).toBe("ok");
    expect(done?.output).toMatchObject({ angle: "Tool use" });
    // And the run is still FINDABLE: a dead worker leaves it for a boot sweep,
    // which is what makes "resume" a platform behaviour rather than a promise
    // this handle keeps.
    expect((await resumable(run.journal)).map((one) => one.runId)).toContain(run.runId);

    await run.restart();
    await run.advanceSleep([REVIEW_SLEEP_ID]);
    expect(run.status).toBe("completed");
    // Five in total: the three the crash already paid for came back out of the
    // journal, and only the report and its summary were re-issued.
    expect(model).toHaveLength(5);
    expect(run.output?.report).toBe("The report about otters.");
  });
});
