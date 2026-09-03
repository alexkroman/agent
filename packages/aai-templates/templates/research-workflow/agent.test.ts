// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the research desk's four tools.
 *
 * All are exercised against a STUBBED `ctx.workflows`, which is the honest way
 * to unit-test a TOOL: what a tool owns is the call it makes, not what the run
 * does afterwards.
 * What these assert is the agent's half of the contract — that the handoff tool
 * passes the correlation key, that the status tool narrows a snapshot correctly
 * before reading it aloud, and that the two tools reaching PAST a status (the
 * progress stream, the early wake) ask for what a voice reply can use.
 *
 * The STEPS are exercised separately, and directly: a step is an ordinary
 * exported async function, so its prompt handling, its parsing and its
 * `FatalError` guards are all testable without an engine.
 *
 * The BODY is driven here only through `createWorkflowCtx`, which records what
 * it asked for and replays nothing. That is a choice rather than a limit now:
 * `runWorkflow` from `@alexkroman1/aai-runtime/testing` will run this body on
 * the real engine, and `link-digest` is the template that shows it — three
 * steps and one suspension, where this desk's body is six model steps deep and a
 * durable spec of it would be mostly stubs. `aai-cli`'s
 * `dev-workflow.scenario.test.ts` is the tier above both, with a built project
 * and a real queue.
 */

import type { WorkflowClient } from "@alexkroman1/aai";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import {
  createRunSnapshot,
  createToolContext,
  createWorkflowCtx,
  parseSchemaInput,
  type StubGatewayCall,
  schemaInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { mockWorkflows, installStubGateway as stubGateway } from "@alexkroman1/aai/testing/vitest";
import { visitWebpage, webSearch } from "@alexkroman1/aai/tools";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { research } from "./shared.ts";
import {
  countSources,
  dedupe,
  findGaps,
  investigate,
  planAngles,
  REVIEW_DELAY_MS,
  researchFlow,
  writeBrief,
  writeReport,
} from "./workflows/research.ts";

/**
 * The web, faked at the SDK's own seam.
 *
 * `webSearch` and `visitWebpage` screen a URL and then really fetch it, through
 * an undici dispatcher a `globalThis.fetch` stub cannot reach — so mocking the
 * module is the only honest way to keep this suite offline. What is asserted is
 * that the researcher CALLS them with what the model asked for; the builtins'
 * own behaviour is `aai`'s to test, and it does.
 */
vi.mock("@alexkroman1/aai/tools", () => ({
  webSearch: vi.fn(async () => ({
    results: [{ title: "Otters", url: "https://otters.example/tools" }],
  })),
  visitWebpage: vi.fn(async () => ({ content: "The page body." })),
}));

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";

/**
 * Every tool here is driven through the agent's own table, by the name the model
 * calls.
 *
 * The second parameter is args-or-context, which is `runTool`'s own shape: three
 * of this desk's four tools take no arguments, and the `{}` those calls were
 * obliged to pass sat between the two values a reader cares about.
 */
const run = toolRunner(agentDef);

/**
 * A `ctx.workflows` that records `start` and answers `find` from a fixture.
 *
 * Returned WITHOUT a cast, which is the property worth keeping: a cast would
 * also stop reporting the day `WorkflowClient` grows a method, and this stub is
 * how the template's tools reach the client at all. `mockWorkflows`
 * (`@alexkroman1/aai/testing/vitest`) is what keeps that affordable — a `vi.fn`
 * per method over one `runs` list, filling in what this desk does not drive, so
 * the day the client does grow a method only the tests using it change.
 * `stream`/`streamTail` are left rejecting on purpose: `research_progress` reads
 * progress through `lastLine`, and composing those two by hand is the hazard
 * `lastLine` exists to remove.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  // Name only: `WorkflowSummary.description` is optional, so passing this
  // desk's through would mean handing `description: undefined` to a field that
  // does not accept it. Nothing here reads the description anyway.
  return mockWorkflows({ runs, names: ["research"] });
}

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    // `toContain` rather than an exact key list: a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — this key is a STRING to everything
    // outside this file (the REST route, `ctx.workflows.get`, a schedule), so
    // renaming it is a runtime 404 rather than a compile error, and nothing
    // else says so.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("research");
    expect(agentDef.workflows?.research).toBe(research);
  });

  test("with an input schema, so a bad topic fails at the call site", async () => {
    // `parseSchemaInput` / `schemaInputIssues` rather than a reach through
    // `["~standard"].validate`: that is the vendor WIRE contract, and whether it
    // answers synchronously or with a promise is the vendor's business — a
    // missing `await` there leaves `.issues` undefined and the refusing half
    // passes for the wrong reason.
    const parsed = await parseSchemaInput(research.input, { topic: "otters", requestedBy: "s" });
    expect(parsed).toMatchObject({ topic: "otters" });
    expect(
      await schemaInputIssues(research.input, { topic: "no", requestedBy: "s" }),
    ).toBeDefined();
  });
});

/**
 * The options `request_research` starts its run with.
 *
 * AWAITED rather than `void`-ed. Reading a mock's call list off a floating
 * promise worked only because the tool body happens to reach `start` before its
 * first `await`; anything async landing ahead of that would have made this
 * return `undefined` and the reader throw a `TypeError` instead of failing on
 * the option it is about — and the dropped promise is an unhandled rejection
 * either way.
 *
 * The return type is inferred from the mock, so `notify` arrives typed and the
 * caller needs no cast.
 */
async function workflowsStartOptions() {
  const workflows = stubWorkflows();
  const ctx = createToolContext({ workflows });
  await run("request_research", { topic: "otters" }, ctx);
  return vi.mocked(workflows.start).mock.calls[0]?.[2];
}

describe("request_research", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await run("request_research", { topic: "otters" }, ctx);

    expect(workflows.start).toHaveBeenCalledWith(
      research,
      { topic: "otters", requestedBy: ctx.sessionId },
      // `key` is the DURABLE handle — a later call finds the run by it — and
      // `notify` is the live one: this session is told when the run lands, which
      // is what makes the agent's "I'll let you know" true.
      { key: ctx.sessionId, notify: expect.stringContaining("read the summary") },
    );
    expect(result).toMatchObject({ started: true, runId: "wrun_stub", topic: "otters" });
  });

  test("asks to be TOLD when the run lands, rather than waiting to be asked", async () => {
    // The gap this closes: the agent promised an update, the run finished, and
    // nothing made it speak — so the caller had to think to ask again. A voice
    // agent that starts durable work and never announces it is the shape to
    // avoid, and one option is the whole fix.
    const options = await workflowsStartOptions();
    expect(options, "request_research started no run").toBeDefined();
    expect(typeof options?.notify).toBe("string");
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await run("request_research", { topic: "otters" }, createToolContext({ workflows }));
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(research);
  });
});

describe("research_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await run("research_status", ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads a completed run's summary and source count back", async () => {
    const runs = [
      createRunSnapshot({
        workflow: "research",
        status: "completed",
        output: { topic: "otters", summary: "Otters use tools.", sources: 3, filedAt: "now" },
      }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Otters use tools.");
    expect(result.runs[0]).toContain("3 sources");
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({
      workflows: stubWorkflows([createRunSnapshot({ workflow: "research", status: "running" })]),
    });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working on it.");
  });

  test("surfaces a failed run's message instead of swallowing it", async () => {
    const runs = [
      createRunSnapshot({ workflow: "research", status: "failed", error: "model unavailable" }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("model unavailable");
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await run("research_status", ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(research, ctx.sessionId, { limit: 3 });
  });
});

describe("research_progress", () => {
  test("reads the run's own progress line rather than its status", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.lastLine).mockResolvedValue("Found 3 sources.");
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ progress: "Found 3 sources." });
  });

  test("asks for the LAST line, not the whole log", async () => {
    // A voice reply cannot recite every line the run has written. `lastLine` is
    // the whole request — the bound that keeps an empty channel from hanging
    // belongs to the method, so nothing here composes `streamTail` and `stream`.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.lastLine).mockResolvedValue("a");
    await run("research_progress", createToolContext({ workflows }));
    expect(workflows.lastLine).toHaveBeenCalledWith("wrun_1");
  });

  test("a run that has written nothing yet says so", async () => {
    // `lastLine` resolves `undefined` for an empty channel, and this is the arm
    // the tool branches on. That an empty channel does not HANG — it is never
    // closed, so a stream opened on one waits for a line that may never come —
    // is `lastLine`'s own guarantee now, and `aai`'s to test.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Started, nothing to report yet." });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.lastLine).not.toHaveBeenCalled();
  });
});

describe("file_it_now", () => {
  test("wakes the sleeping run so the review wait ends early", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(1);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(workflows.wakeUp).toHaveBeenCalledWith("wrun_1");
    expect(result).toMatchObject({ filed: true });
  });

  test("a run that was not waiting is reported honestly, not as a failure", async () => {
    // `wakeUp` answering 0 means the run had already moved past its sleep — the
    // same shape as `cancel` answering false.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(0);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(result).toMatchObject({ filed: false });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.wakeUp).not.toHaveBeenCalled();
  });
});

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

  test("investigate stops when the model says so, without inventing findings", async () => {
    const calls = stubGateway([JSON.stringify({ action: "stop", why: "nothing to add" })]);
    expect(await investigate(brief, "Tool use")).toEqual({
      angle: "Tool use",
      findings: "Nothing was found on this angle.",
      sources: [],
    });
    // One call: it stopped, so there was nothing to compress.
    expect(calls).toHaveLength(1);
  });

  test("investigate searches, reads, and compresses what it saw", async () => {
    const calls = stubGateway([
      JSON.stringify({ action: "search", query: "otter tool use" }),
      JSON.stringify({ action: "read", url: "https://otters.example/tools" }),
      JSON.stringify({ action: "stop", why: "enough" }),
      JSON.stringify({
        findings: "Sea otters crack shellfish with stones [1].",
        sources: [{ title: "Otters", url: "https://otters.example/tools" }],
      }),
    ]);

    const note = await investigate(brief, "Tool use");

    expect(webSearch).toHaveBeenCalledWith({ query: "otter tool use", maxResults: 5 });
    expect(visitWebpage).toHaveBeenCalledWith("https://otters.example/tools");
    expect(note.findings).toContain("crack shellfish");
    expect(note.sources).toEqual([{ title: "Otters", url: "https://otters.example/tools" }]);
    // Everything the researcher saw reaches the compression stage, which is what
    // keeps the journaled result small without summarizing the findings away.
    expect(promptOf(calls, 3)).toContain("The page body.");
  });

  test("investigate stops at its BUDGET, whatever the model asks for", async () => {
    // The budget is the mechanism, not the prompt: a run whose cost is decided
    // by a model is a run nobody can price.
    const calls = stubGateway([JSON.stringify({ action: "search", query: "again" })]);
    await investigate(brief, "Tool use");
    // Six actions, then one compression call.
    expect(calls).toHaveLength(7);
  });

  test("a failed search costs an action rather than the whole angle", async () => {
    vi.mocked(webSearch).mockRejectedValueOnce(new Error("search is down"));
    const calls = stubGateway([
      JSON.stringify({ action: "search", query: "otters" }),
      JSON.stringify({ action: "stop", why: "give up" }),
      JSON.stringify({ findings: "Nothing usable.", sources: [] }),
    ]);
    const note = await investigate(brief, "Tool use");
    expect(note.findings).toBe("Nothing usable.");
    expect(promptOf(calls, 2)).toContain("search is down");
  });

  test("both investigate waves are called with more attempts than the default", async () => {
    // The retry policy is an argument to `ctx.step` now rather than a
    // `maxRetries` property, so it is observable only at the CALL — and there
    // are two calls, one per wave, which is exactly the kind of thing a property
    // could not have said differently.
    // `planAngles`' result is what the fan-out iterates, so it is supplied
    // rather than run — the rest of the body needs no page and no model.
    const ctx = createWorkflowCtx({
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
    for (const step of investigations) expect(step.maxAttempts).toBeGreaterThan(3);
  });

  test("a rate limit is RETRYABLE, so the engine tries again", async () => {
    // The message alone cannot say this — a 429 and a 401 read alike — so what
    // is asserted is the class the engine actually branches on.
    stubGateway([""], { status: 429 });
    const err = await investigate(brief, "Tool use").catch((thrown: unknown) => thrown);
    expect(RetryableError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/HTTP 429/);
  });

  test("a rejected request is FATAL rather than retried five times", async () => {
    stubGateway([""], { status: 401 });
    const err = await investigate(brief, "Tool use").catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/HTTP 401/);
  });

  test("a missing key is FATAL, naming the key", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway(["anything"]);
    const err = await investigate(brief, "Tool use").catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/ASSEMBLYAI_API_KEY/);
  });

  test("a malformed `sources` falls back to what the researcher was shown", async () => {
    // `.catch(undefined)` on that field rather than a bare `.optional()`: the
    // findings are already compressed by this point, and throwing them away to
    // research the angle again is the expensive way to handle one bad field.
    const calls = stubGateway([
      JSON.stringify({ action: "search", query: "otters" }),
      JSON.stringify({ action: "stop" }),
      JSON.stringify({ findings: "Otters use stones.", sources: "not a list" }),
    ]);
    const note = await investigate(brief, "Tool use");

    expect(note.findings).toBe("Otters use stones.");
    expect(note.sources).toEqual([{ title: "Otters", url: "https://otters.example/tools" }]);
    // Three calls, not four: the reply was USED, not retried.
    expect(calls).toHaveLength(3);
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
 * `researchFlow` itself, on the real replay engine.
 *
 * The block above drives this body through `createWorkflowCtx`, which records
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
    // investigate#0's first action: stop, which also skips `compress` (nothing
    // was seen, so there is nothing to compress).
    JSON.stringify({ action: "stop", why: "nothing to add" }),
    // findGaps — none, so there is no second wave.
    JSON.stringify({ angles: [] }),
    // writeReport, then its summary.
    "The report about otters.",
    "Otters use tools.",
  ];
  const INPUT = { topic: "otters", requestedBy: "sess_1" };

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("suspends on the review wait with the whole report already journaled", async () => {
    const started = Date.now();
    const model = stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });

    // Not blocked — suspended. The sandbox is free here, which is the whole
    // reason a caller can hang up.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(started + REVIEW_DELAY_MS);
    // Everything except the filing is durable already, and `file` has not run.
    expect(run.steps.map((step) => step.key)).toEqual([
      "findGaps#0",
      "investigate#0",
      "planAngles#0",
      "writeBrief#0",
      "writeReport#0",
    ]);
    expect(model).toHaveLength(6);
  });

  test("resumes past the review wait and files, without researching again", async () => {
    const model = stubGateway(SCRIPT);
    const run = await runWorkflow(research, INPUT, { name: "research" });
    // `advanceSleep` is `ctx.workflows.wakeUp`'s own mechanism, which is what
    // the `file_it_now` tool calls to cut the review short — so this is that
    // tool's effect, asserted on the run rather than on the tool.
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      topic: "otters",
      summary: "Otters use tools.",
      report: "The report about otters.",
      angles: ["Tool use"],
    });
    expect(run.output?.filedAt).toBeTruthy();
    expect(run.deliveries).toBe(2);
    // The second walk re-entered the body from the top and paid the model
    // NOTHING: every step above the wait came back out of the journal.
    expect(model).toHaveLength(6);
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
    expect(run.steps.map((step) => step.key)).toEqual([
      "findGaps#0",
      "investigate#0",
      "planAngles#0",
      "writeBrief#0",
    ]);
    const spentBeforeTheCrash = model.length;
    expect(spentBeforeTheCrash).toBe(4);

    await run.restart();
    await run.advanceSleep();
    expect(run.status).toBe("completed");
    // Six in total: the four the crash already paid for came back out of the
    // journal, and only the report and its summary were re-issued.
    expect(model).toHaveLength(6);
    expect(run.output?.report).toBe("The report about otters.");
  });
});
