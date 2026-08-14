// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the research desk's four tools.
 *
 * All are exercised against a STUBBED `ctx.workflows`, which is the only honest
 * way to unit-test them: the real client needs a Workflow DevKit world, and the
 * bodies in `workflows/` are only durable once the build has transformed them.
 * What these assert is the agent's half of the contract — that the handoff tool
 * passes the correlation key, that the status tool narrows a snapshot correctly
 * before reading it aloud, and that the two tools reaching PAST a status (the
 * progress stream, the early wake) ask for what a voice reply can use.
 *
 * The STEPS are exercised separately, and directly: imported through vitest with
 * no bundler in the path, a `"use step"` function is an ordinary async function,
 * so its prompt handling, its parsing and its `FatalError` guards are all
 * testable — while durability, suspension and replay are not. The body itself is
 * not driven here for that reason; `aai-cli`'s `dev-workflow.integration.test.ts`
 * builds a project and runs one.
 */

import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createStubWorkflows, createToolContext } from "@alexkroman1/aai/testing";
import { visitWebpage, webSearch } from "@alexkroman1/aai/tools";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { research } from "./agent.ts";
import {
  countSources,
  dedupe,
  findGaps,
  investigate,
  planAngles,
  stripFence,
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

/**
 * A `ctx.workflows` that records `start` and answers `find` from a fixture.
 *
 * Returned WITHOUT a cast, which is the property worth keeping: a cast would
 * also stop reporting the day `WorkflowClient` grows a method, and this stub is
 * how the template's tools reach the client at all. `createStubWorkflows` is
 * what keeps that affordable — it fills in the methods this desk does not
 * drive, so the day the client does grow one, only the tests that use it change.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  return createStubWorkflows({
    start: vi.fn(async () => "wrun_stub"),
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => runs),
    recent: vi.fn(async () => runs),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 0),
    // A tail of 0 means "one line written", which is the case the tools read.
    // The `-1` case is overridden per test, because it is the one that decides
    // whether the stream is opened at all.
    streamTail: vi.fn(async () => 0),
    stream: vi.fn(async () => lineStream([])),
    // Name only: `WorkflowDef.description` is optional, so passing it through
    // would mean handing `description: undefined` to a field that does not
    // accept it. Nothing here reads the description anyway.
    listing: () => [{ name: "research" }],
  });
}

/** What a run's progress channel looks like from the read side. */
function lineStream(lines: readonly string[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const line of lines) controller.enqueue(line);
      controller.close();
    },
  });
}

function snapshot(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "research",
    createdAt: Date.UTC(2026, 7, 12),
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["research"]);
    expect(agentDef.workflows?.research).toBe(research);
  });

  test("with an input schema, so a bad topic fails at the call site", async () => {
    const result = await research.input?.["~standard"].validate({
      topic: "otters",
      requestedBy: "s",
    });
    expect(result?.issues).toBeUndefined();
    const bad = await research.input?.["~standard"].validate({ topic: "no", requestedBy: "s" });
    expect(bad?.issues).toBeDefined();
  });
});

/** The options `request_research` starts its run with. */
function workflowsStartOptions(): unknown {
  const workflows = stubWorkflows();
  const ctx = createToolContext({ workflows });
  void agentDef.tools.request_research?.execute({ topic: "otters" }, ctx);
  return vi.mocked(workflows.start).mock.calls[0]?.[2];
}

describe("request_research", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.request_research?.execute({ topic: "otters" }, ctx);

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

  test("asks to be TOLD when the run lands, rather than waiting to be asked", () => {
    // The gap this closes: the agent promised an update, the run finished, and
    // nothing made it speak — so the caller had to think to ask again. A voice
    // agent that starts durable work and never announces it is the shape to
    // avoid, and one option is the whole fix.
    const notify = (workflowsStartOptions() as { notify?: unknown }).notify;
    expect(typeof notify).toBe("string");
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await agentDef.tools.request_research?.execute(
      { topic: "otters" },
      createToolContext({ workflows }),
    );
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(research);
  });
});

describe("research_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await agentDef.tools.research_status?.execute({}, ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads a completed run's summary and source count back", async () => {
    const runs = [
      snapshot({
        status: "completed",
        output: { topic: "otters", summary: "Otters use tools.", sources: 3, filedAt: "now" },
      }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Otters use tools.");
    expect(result.runs[0]).toContain("3 sources");
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([snapshot({ status: "running" })]) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working on it.");
  });

  test("surfaces a failed run's message instead of swallowing it", async () => {
    const runs = [snapshot({ status: "failed", error: "model unavailable" })];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("model unavailable");
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await agentDef.tools.research_status?.execute({}, ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(research, ctx.sessionId, { limit: 3 });
  });
});

describe("research_progress", () => {
  test("reads the run's own progress line rather than its status", async () => {
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.stream).mockResolvedValue(lineStream(["Found 3 sources."]));
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.research_progress?.execute({}, ctx);
    expect(result).toMatchObject({ progress: "Found 3 sources." });
  });

  test("asks for the LAST line, not the whole log", async () => {
    // A voice reply cannot recite every line the run has written.
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.stream).mockResolvedValue(lineStream(["a"]));
    await agentDef.tools.research_progress?.execute({}, createToolContext({ workflows }));
    expect(workflows.stream).toHaveBeenCalledWith("wrun_1", { startIndex: -1 });
  });

  test("a run that has written nothing yet says so WITHOUT opening the stream", async () => {
    // Not a shortcut: an empty progress channel is never closed, so reading one
    // would wait for a line that arrives whenever the next step writes — i.e.
    // the tool hangs instead of answering. The tail is how that is known.
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.streamTail).mockResolvedValue(-1);
    const result = await agentDef.tools.research_progress?.execute(
      {},
      createToolContext({ workflows }),
    );
    expect(result).toMatchObject({ note: "Started, nothing to report yet." });
    expect(workflows.stream).not.toHaveBeenCalled();
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await agentDef.tools.research_progress?.execute(
      {},
      createToolContext({ workflows }),
    );
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.stream).not.toHaveBeenCalled();
  });
});

describe("file_it_now", () => {
  test("wakes the sleeping run so the review wait ends early", async () => {
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(1);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(workflows.wakeUp).toHaveBeenCalledWith("wrun_1");
    expect(result).toMatchObject({ filed: true });
  });

  test("a run that was not waiting is reported honestly, not as a failure", async () => {
    // `wakeUp` answering 0 means the run had already moved past its sleep — the
    // same shape as `cancel` answering false.
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(0);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(result).toMatchObject({ filed: false });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.wakeUp).not.toHaveBeenCalled();
  });
});

describe("the pure helpers", () => {
  test("stripFence unwraps the fence a model puts JSON in", () => {
    // Models fence JSON often enough that refusing one would cost a whole retry
    // for a reply that was otherwise correct.
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('{"a":1}')).toBe('{"a":1}');
  });

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
   * A gateway answering a QUEUE of completions, recording what it was asked.
   *
   * A queue rather than one fixed reply because the researcher's loop is a
   * CONVERSATION — search, then read, then stop — and a stub that says the same
   * thing every turn can only ever drive it into its budget.
   */
  function stubGateway(replies: readonly string[], status = 200) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        // The LAST reply repeats, so a spec names only the turns it cares about.
        const content = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "";
        return new Response(
          status === 200
            ? JSON.stringify({ choices: [{ message: { content } }] })
            : JSON.stringify({ error: "nope" }),
          { status, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  }

  /** The prompt the Nth model call carried. */
  function promptOf(calls: { body: Record<string, unknown> }[], at: number): string {
    const messages = calls[at]?.body.messages as { role: string; content: string }[] | undefined;
    return messages?.at(-1)?.content ?? "";
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

    expect(webSearch).toHaveBeenCalledWith({ query: "otter tool use", max_results: 5 });
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

  test("investigate retries beyond the default, because a rate limit is expected", () => {
    expect(investigate.maxRetries).toBeGreaterThan(3);
  });

  test("a rate limit throws plainly, so the step is retried", async () => {
    stubGateway([""], 429);
    await expect(investigate(brief, "Tool use")).rejects.toThrow(/HTTP 429/);
  });

  test("a rejected request fails FATALLY rather than being retried five times", async () => {
    stubGateway([""], 401);
    await expect(investigate(brief, "Tool use")).rejects.toThrow(/HTTP 401/);
  });

  test("a missing key fails FATALLY, naming the key", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway(["anything"]);
    await expect(investigate(brief, "Tool use")).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
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
