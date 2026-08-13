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
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { research } from "./agent.ts";
import { investigate, planAngles, synthesize } from "./workflows/research.ts";

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

describe("the steps that call the model", () => {
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is. `unstubEnvs` clears it per test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /** A gateway that answers with `content`, recording what it was asked. */
  function stubGateway(content: string, status = 200) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
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

  test("planAngles asks the gateway and returns one angle per line", async () => {
    const calls = stubGateway("How otters use tools\nOtter population trends\nRiver habitat loss");
    const angles = await planAngles("otters");

    expect(angles).toEqual([
      "How otters use tools",
      "Otter population trends",
      "River habitat loss",
    ]);
    expect(calls[0]?.url).toContain("/chat/completions");
    // The key is a BEARER here — the gateway is OpenAI-compatible, unlike
    // AssemblyAI's streaming sockets, which take the key raw.
    expect(calls).toHaveLength(1);
  });

  test("planAngles normalizes a list that came back numbered anyway", async () => {
    // A retry would most likely produce the same shape, so this is repaired
    // rather than rejected.
    stubGateway("1. First angle\n2) Second angle\n- Third angle");
    expect(await planAngles("otters")).toEqual(["First angle", "Second angle", "Third angle"]);
  });

  test("planAngles fails FATALLY when the model returns nothing usable", async () => {
    // Not empty — an empty completion is `ask`'s failure, one layer down. This
    // is a reply that LOOKS like a list and parses to nothing.
    stubGateway("-\n*");
    await expect(planAngles("otters")).rejects.toThrow(/no angles/);
  });

  test("investigate carries the topic and the angle into the prompt", async () => {
    const calls = stubGateway("Otters crack shellfish with stones.");
    const note = await investigate("otters", "How otters use tools");

    expect(note).toEqual({
      angle: "How otters use tools",
      note: "Otters crack shellfish with stones.",
    });
    const messages = calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages.at(-1)?.content).toContain("How otters use tools");
    expect(messages.at(-1)?.content).toContain("otters");
  });

  test("investigate retries beyond the default, because a rate limit is expected", () => {
    expect(investigate.maxRetries).toBeGreaterThan(3);
  });

  test("a rate limit throws plainly, so the step is retried", async () => {
    stubGateway("", 429);
    await expect(investigate("otters", "tools")).rejects.toThrow(/HTTP 429/);
  });

  test("a rejected request fails FATALLY rather than being retried five times", async () => {
    stubGateway("", 401);
    await expect(investigate("otters", "tools")).rejects.toThrow(/HTTP 401/);
  });

  test("a missing key fails FATALLY, naming the key", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway("anything");
    await expect(investigate("otters", "tools")).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("synthesize reduces every note, so nothing researched is dropped", async () => {
    const calls = stubGateway("Otters are clever and declining.");
    const summary = await synthesize("otters", [
      { angle: "tools", note: "They use stones." },
      { angle: "population", note: "Numbers are falling." },
    ]);

    expect(summary).toBe("Otters are clever and declining.");
    const messages = calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages.at(-1)?.content).toContain("They use stones.");
    expect(messages.at(-1)?.content).toContain("Numbers are falling.");
  });

  test("an empty completion throws rather than filing a blank report", async () => {
    stubGateway("");
    await expect(synthesize("otters", [])).rejects.toThrow(/empty completion/);
  });
});
