// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the research desk.
 *
 * Three tiers: the two tools against a stubbed `ctx.workflows` (what a tool owns
 * is the call it makes), the desk's configuration and delivery through
 * `createWorkflowContext`, and the whole run on the real replay engine
 * (`runWorkflow`). The pass itself — the brief's fallback, the planner's width
 * cap, the researcher's cite-else-opened sources — is asserted in the SDK's own
 * `sdk/deep-research.test.ts`; what is asserted here is this desk's half.
 */

import agentDef from "virtual:aai/agent";
import { describeRun } from "@alexkroman1/aai";
import { renderSlackPlainText } from "@alexkroman1/aai/channels";
import {
  DEFAULT_DEEP_RESEARCH_BUDGET,
  DEFAULT_DEEP_RESEARCH_PROMPTS,
} from "@alexkroman1/aai/experimental";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import type { WorkflowTestRun, WorkflowTestWait } from "@alexkroman1/aai-runtime/testing";
import {
  createRunSnapshot,
  createToolContext,
  createWorkflowContext,
  parseSchemaInput,
  runWorkflow,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
  schemaInputIssues,
} from "@alexkroman1/aai-runtime/testing";
import {
  describeAgent,
  installStubGateway,
  installStubReporter,
  installStubStepDelegate,
  installStubStepFetch,
  installStubWorkflows,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import fileItNow from "./tools/file_it_now.ts";
import requestResearch from "./tools/request_research.ts";
import {
  FILING_TEXT_PARAM_ENV,
  FILING_WEBHOOK_ENV,
  type Filing,
  file,
  filingChannel,
  renderFiling,
} from "./workflows/filing.ts";
import { BRIEF_SUMMARY_SYSTEM, BRIEF_SYSTEM } from "./workflows/prompts.ts";
import research, { deliverResearch, REVIEW_DELAY_MS } from "./workflows/research.ts";

/** A finished pass, as the status line reads it. */
function findings(over: { summary?: string; sources?: number } = {}) {
  return {
    topic: "otters",
    summary: "Otters use tools.",
    report: "# Otters",
    sources: 3,
    angles: ["Tool use"],
    filedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describeAgent(agentDef, (run) => {
  test("declares its workflow by its file name, with an input schema", async () => {
    // `workflows/research.ts` is discovered the way `tools/` is, so the name the
    // run API and the builtins use is the file's.
    expect(agentDef.workflows?.research).toBe(research);
    const parsed = await parseSchemaInput(research.input, { topic: "otters", requestedBy: "s" });
    expect(parsed).toMatchObject({ topic: "otters" });
    expect(
      await schemaInputIssues(research.input, { topic: "no", requestedBy: "s" }),
    ).toBeDefined();
  });

  describe("request_research", () => {
    test("starts a run on the session's key, and asks to be TOLD when it lands", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      const ctx = createToolContext({ workflows });
      const result = await run(requestResearch, { topic: "otters" }, ctx);

      // The def, not its name, so the input is typed; no `key`, because a
      // tool's start is keyed by the session by default; and `notify` is what
      // makes the agent's "I'll let you know" true.
      expect(workflows.start).toHaveBeenCalledWith(
        research,
        { topic: "otters", requestedBy: ctx.sessionId },
        { notify: expect.stringContaining("read the summary") },
      );
      expect(result).toEqual({ started: true, runId: "wrun_stub", topic: "otters" });
    });
  });

  describe("file_it_now", () => {
    test("wakes the REVIEW wait by its label, not whatever the run happens to hold", async () => {
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(research, { status: "running" })],
      });
      vi.mocked(workflows.wakeUp).mockResolvedValue(1);
      const result = await run(fileItNow, createToolContext({ workflows }));
      expect(workflows.wakeUp).toHaveBeenCalledWith("wrun_1", {
        correlationIds: ["reviewWindow"],
      });
      expect(result).toMatchObject({ filed: true });
    });

    test("a run that was not waiting is reported honestly, not as a failure", async () => {
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(research, { status: "running" })],
      });
      const result = await run(fileItNow, createToolContext({ workflows }));
      expect(result).toMatchObject({ filed: false, note: expect.stringContaining("moved on") });
    });

    test("says nothing is in flight when the session's runs have all finished", async () => {
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(research, { status: "completed", output: findings() })],
      });
      const result = await run(fileItNow, createToolContext({ workflows }));
      expect(result).toMatchObject({ filed: false, note: expect.stringContaining("in flight") });
      expect(workflows.wakeUp).not.toHaveBeenCalled();
    });
  });
});

describe("what the status builtin says per run", () => {
  test("reads a completed run's summary and source count back", () => {
    const run = createRunSnapshot(research, { status: "completed", output: findings() });
    expect(describeRun(research, run)).toContain("Otters use tools.");
    expect(describeRun(research, run)).toContain("3 sources");
  });

  test("says WHEN it was asked for, so two requests can be told apart", () => {
    const twelveMinutesAgo = createRunSnapshot(research, {
      status: "running",
      createdAt: Date.now() - 12 * 60_000,
    });
    expect(describeRun(research, twelveMinutesAgo)).toMatch(/^12 minutes ago: still working/);
    const justNow = createRunSnapshot(research, { status: "running", createdAt: Date.now() });
    expect(describeRun(research, justNow)).toMatch(/^Just now/);
  });

  test("surfaces a failed run's message instead of swallowing it", () => {
    const run = createRunSnapshot(research, { status: "failed", error: "model unavailable" });
    expect(describeRun(research, run)).toContain("model unavailable");
  });
});

describe("the desk's research configuration", () => {
  const INPUT = { topic: "Tool use", requestedBy: "Ada" };
  const brief = { brief: "How otters use tools", criteria: ["Which species"] };

  test("the brief and the summary are the PHONE prompts, the rest the SDK's", async () => {
    // Every stage but the two this desk overrides is answered, so the two
    // model calls that remain are exactly the overridden ones.
    const calls = installStubGateway([
      JSON.stringify({ brief: "How otters use tools", criteria: [] }),
      "# Otters",
      "Otters use stones.",
    ]);
    const ctx = createWorkflowContext({
      results: {
        planAngles: ["Tool use"],
        investigate: { angle: "Tool use", findings: "f", sources: [] },
        findGaps: [],
        file: "2026-01-01T00:00:00.000Z",
      },
    });
    await research.run(INPUT, ctx);

    expect(calls[0]?.system?.startsWith(BRIEF_SYSTEM)).toBe(true);
    expect(calls[1]?.system).toBe(DEFAULT_DEEP_RESEARCH_PROMPTS.report);
    expect(calls[2]?.system).toBe(BRIEF_SUMMARY_SYSTEM);
  });

  test("the researcher keeps the keyless web builtins and the default budget", async () => {
    const desk = installStubStepDelegate({ routes: { researcher: "found things" } });
    const ctx = createWorkflowContext({
      results: {
        writeBrief: brief,
        planAngles: ["Tool use"],
        findGaps: [],
        writeReport: { report: "r", summary: "s" },
        file: "2026-01-01T00:00:00.000Z",
      },
    });
    await research.run(INPUT, ctx);

    const researcher = desk.calls[0]?.subagent;
    expect(researcher?.builtinTools).toEqual(["web_search", "visit_webpage"]);
    expect(researcher?.maxSteps).toBe(DEFAULT_DEEP_RESEARCH_BUDGET.researcherSteps);
    expect(desk.calls[0]?.options.context).toContain("How otters use tools");
  });

  test("the review wait comes after the report and before filing, under the label file_it_now wakes", async () => {
    const ctx = createWorkflowContext({
      runSteps: false,
      results: {
        writeBrief: brief,
        planAngles: ["Adoption"],
        findGaps: [],
        investigate: { angle: "Adoption", findings: "f", sources: [] },
        writeReport: { summary: "s", report: "r" },
      },
    });
    await research.run(INPUT, ctx);

    expect(ctx.slept).toMatchObject([{ label: "reviewWindow", until: REVIEW_DELAY_MS }]);
    expect(ctx.steps.map((step) => step.name).slice(-2)).toEqual(["writeReport", "file"]);
  });

  test("deliverResearch answers with what the status line reads back", async () => {
    const ctx = createWorkflowContext({ results: { file: "2026-01-01T00:00:00.000Z" } });
    const source = { title: "Otters", url: "https://otters.example" };
    const out = await deliverResearch(
      {
        topic: "otters",
        brief,
        notes: [{ angle: "Tool use", findings: "f", sources: [source] }],
        sources: [source],
        report: "# Otters",
        summary: "Otters use stones.",
      },
      INPUT,
      ctx,
    );
    expect(out).toEqual({
      topic: "otters",
      summary: "Otters use stones.",
      report: "# Otters",
      sources: 1,
      angles: ["Tool use"],
      filedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("a missing key is FATAL, naming the key, and fails the run rather than filing", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    installStubGateway(["anything"], { apiKey: false });
    const ctx = createWorkflowContext();
    const err = await Promise.resolve(research.run(INPUT, ctx)).catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/ASSEMBLYAI_API_KEY/);
    expect(ctx.steps.map((step) => step.name)).not.toContain("file");
  });

  test("a rate limit is RETRYABLE, so the engine tries again", async () => {
    installStubGateway([""], { status: 429 });
    const err = await Promise.resolve(research.run(INPUT, createWorkflowContext())).catch(
      (thrown: unknown) => thrown,
    );
    expect(RetryableError.is(err)).toBe(true);
  });
});

/**
 * The last step. What is asserted here is this template's half — what a filed
 * report SAYS, and that the channel is resolved from the env rather than
 * assumed; the 4xx/5xx split and the rendering are `@alexkroman1/aai/channels`'.
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

  /** The webhook, answered without a network; anything else is a finding. */
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
    expect(Number.isNaN(Date.parse(filedAt))).toBe(false);
  });

  test("with no webhook it files nowhere, says so, and does not fail the run", async () => {
    // The last step of a five-minute pass is the worst place to discover a
    // missing credential, so the channel is optional by construction.
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
    // and quietly nothing on an incoming webhook.
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
    expect(message.sections?.[0]).toMatchObject({ title: "In short" });
    expect(message.sections?.[1]).toMatchObject({
      title: "Tool use",
      bullets: ["Otters and stones — https://otters.example/tools"],
    });
  });

  test("the message still answers where a destination renders no sections", () => {
    // A Slack workflow trigger takes ONE string, so the SDK folds the whole
    // message down to text; the answer and the sources must survive it.
    const flat = renderSlackPlainText(renderFiling(FILING));

    expect(flat).toContain("crack shellfish");
    expect(flat).toContain("https://otters.example/tools");
  });
});

/**
 * The whole run on the real replay engine, which is the only tier that can
 * reach the desk's promise: **answer the caller now, finish the work later**.
 *
 * The model is scripted POSITIONALLY, which is only safe because the run is
 * made sequential: one angle, and a researcher that stops on its first turn,
 * so the `mapConcurrent` fan-out has a single item and nothing races.
 */
describe("the run is DURABLE", () => {
  const SCRIPT = [
    // writeBrief
    JSON.stringify({ brief: "How otters use tools", criteria: ["Which species"] }),
    // planAngles — ONE, so the fan-out is sequential and the script positional.
    JSON.stringify({ angles: ["Tool use"] }),
    // `investigate` delegates: its model calls are the subagent's, answered by
    // `installStubStepDelegate` below rather than by the gateway.
    // findGaps — none, so there is no second wave.
    JSON.stringify({ angles: [] }),
    // writeReport, then its summary.
    "The report about otters.",
    "Otters use tools.",
  ];
  const INPUT = { topic: "otters", requestedBy: "sess_1" };

  beforeEach(() => {
    // No `RESEARCH_SLACK_WEBHOOK_URL`, so the filing step posts nothing — which
    // is why the gateway counts below are the run's model calls and only those.
    installStubStepDelegate({ routes: { researcher: "Nothing was found on this angle." } });
  });

  /** The step keys a run journaled — the same shape three cases assert on. */
  function stepKeys(run: WorkflowTestRun<unknown>): string[] {
    return run.steps.map((step) => step.key);
  }

  /** The one suspension a research run takes, read off the journal itself. */
  function reviewSleep(run: WorkflowTestRun<unknown>): WorkflowTestWait | undefined {
    return run.waits.find((wait) => wait.correlationId === "reviewWindow");
  }

  test("suspends on the review wait with the whole report already journaled", async () => {
    const started = Date.now();
    const model = installStubGateway(SCRIPT);
    const run = await runWorkflow(agentDef, "research", INPUT);

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
    // FIVE gateway calls for six steps: `investigate`'s turns went to the
    // subagent through the delegate slot.
    expect(model).toHaveLength(5);
    // The open wait is the REVIEW wait, by the label `file_it_now` wakes.
    expect(reviewSleep(run)).toMatchObject({ kind: "sleep", woken: false });
  });

  test("makes no decision a replay could not reproduce", async () => {
    // `reads` records every `ctx.now`/`ctx.random`/`ctx.uuid` the body took, and
    // this body takes none: the fan-out's width comes from a journaled step, and
    // the filing timestamp is a step RESULT.
    installStubGateway(SCRIPT);
    const run = await runWorkflow(agentDef, "research", INPUT);

    expect(run.reads).toEqual([]);
  });

  test("resumes past the review wait and files, without researching again", async () => {
    const model = installStubGateway(SCRIPT);
    const run = await runWorkflow(agentDef, "research", INPUT);
    // `advanceSleep` is `ctx.workflows.wakeUp`'s own mechanism, given the same
    // label `file_it_now` passes.
    await run.advanceSleep(["reviewWindow"]);

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      topic: "otters",
      summary: "Otters use tools.",
      report: "The report about otters.",
      angles: ["Tool use"],
      // A real timestamp: the filing step really ran.
      filedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(run.deliveries).toBe(2);
    // The second walk re-entered the body from the top and paid the model
    // NOTHING: every step above the wait came back out of the journal.
    expect(model).toHaveLength(5);
  });

  test("a worker that dies at the report replays the research rather than repeating it", async () => {
    // The expensive claim. A deep-research pass is five to twelve model calls
    // and as many searches; a resume that redid them would cost the run twice.
    const model = installStubGateway(SCRIPT);
    const run = await runWorkflow(agentDef, "research", INPUT, { crashAt: "writeReport" });

    expect(run.crashed).toBe(true);
    expect(stepKeys(run)).toEqual(["findGaps#0", "investigate#0", "planAngles#0", "writeBrief#0"]);
    // THREE, not four: `investigate` paid the gateway nothing.
    expect(model).toHaveLength(3);
    // The finished angle's own result is sitting in the journal, which is what
    // the second walk answers `investigate#0` from; and the run is still
    // FINDABLE, so a boot sweep resumes it.
    const done = run.steps.find((step) => step.name === "investigate");
    expect(done?.status).toBe("ok");
    expect(done?.output).toMatchObject({ angle: "Tool use" });
    expect(run.resumable).toBe(true);

    await run.restart();
    await run.advanceSleep(["reviewWindow"]);
    expect(run.status).toBe("completed");
    // Five in total: only the report and its summary were re-issued.
    expect(model).toHaveLength(5);
    expect(run.output).toMatchObject({ report: "The report about otters." });
  });
});
