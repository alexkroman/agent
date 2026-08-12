// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the transcription desk's three tools, and for the assembly its
 * workflow body does.
 *
 * The tools are exercised against a STUBBED `ctx.workflows`, for the reason
 * `research-desk`'s spec gives: the real client needs a Workflow DevKit world,
 * and the bodies in `workflows/` are only durable once the build has transformed
 * them.
 *
 * The body is exercised DIRECTLY, which is new here and worth being precise
 * about. Imported through vitest with no bundler in the path, `transcribeFlow`
 * is an ordinary async function and its `"use step"` calls are ordinary calls —
 * so what these assert is the pure half: that the batched fan-out puts every
 * chunk in the transcript in recording order, that a partial final batch is not
 * dropped, and that an unknown recording fails rather than transcribing nothing.
 * They assert NOTHING about durability, replay, or step correlation, which only
 * exist after the transform.
 */

import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef, { transcribe } from "./agent.ts";
import { transcribeFlow } from "./workflows/transcribe.ts";

/** A `ctx.workflows` that records `start`/`cancel` and answers `find` from a fixture. */
function stubWorkflows(runs: WorkflowRunSnapshot[] = [], cancelled = true): WorkflowClient {
  return {
    start: vi.fn(async () => "wrun_stub"),
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => runs),
    recent: vi.fn(async () => runs),
    cancel: vi.fn(async () => cancelled),
    listing: () => [{ name: "transcribe", description: transcribe.description }],
  } as WorkflowClient;
}

function snapshot(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "transcribe",
    createdAt: Date.UTC(2026, 7, 12),
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** A completed run's output, with the fields the desk reads. */
function completed(over: Partial<Record<string, unknown>> = {}): WorkflowRunSnapshot {
  return snapshot({
    status: "completed",
    output: {
      recordingId: "standup",
      chunks: 8,
      words: 12,
      transcript: "a short one",
      filedAt: "2026-08-12T00:00:00.000Z",
      ...over,
    },
  });
}

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["transcribe"]);
    expect(agentDef.workflows?.transcribe).toBe(transcribe);
  });

  test("with an input schema, so an empty recording id fails at the call site", async () => {
    const ok = await transcribe.input?.["~standard"].validate({
      recordingId: "standup",
      requestedBy: "s",
    });
    expect(ok?.issues).toBeUndefined();
    const bad = await transcribe.input?.["~standard"].validate({
      recordingId: "",
      requestedBy: "s",
    });
    expect(bad?.issues).toBeDefined();
  });
});

describe("request_transcript", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.request_transcript?.execute(
      { recordingId: "standup" },
      ctx,
    );

    expect(workflows.start).toHaveBeenCalledWith(
      transcribe,
      { recordingId: "standup", requestedBy: ctx.sessionId },
      { key: ctx.sessionId },
    );
    expect(result).toMatchObject({ started: true, runId: "wrun_stub", recordingId: "standup" });
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await agentDef.tools.request_transcript?.execute(
      { recordingId: "standup" },
      createToolContext({ workflows }),
    );
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(transcribe);
  });
});

describe("transcript_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await agentDef.tools.transcript_status?.execute({}, ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads a completed run's chunk and word counts back", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([completed()]) });
    const result = (await agentDef.tools.transcript_status?.execute({}, ctx)) as {
      runs: string[];
    };
    expect(result.runs[0]).toContain("8 chunks");
    expect(result.runs[0]).toContain("12 words");
  });

  test("reads a short transcript aloud", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([completed()]) });
    const result = (await agentDef.tools.transcript_status?.execute({}, ctx)) as {
      transcript?: string;
    };
    expect(result.transcript).toBe("a short one");
  });

  test("withholds a long transcript rather than reading it down the phone", async () => {
    const long = completed({ words: 4000, transcript: "…forty minutes of it…" });
    const ctx = createToolContext({ workflows: stubWorkflows([long]) });
    const result = (await agentDef.tools.transcript_status?.execute({}, ctx)) as {
      transcript?: string;
    };
    expect(result.transcript).toBeUndefined();
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([snapshot({ status: "running" })]) });
    const result = (await agentDef.tools.transcript_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working on that one.");
  });

  test("surfaces a failed run's message instead of swallowing it", async () => {
    const runs = [snapshot({ status: "failed", error: 'No recording named "nope"' })];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await agentDef.tools.transcript_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain('No recording named "nope"');
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await agentDef.tools.transcript_status?.execute({}, ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(transcribe, ctx.sessionId, { limit: 3 });
  });
});

describe("cancel_transcript", () => {
  test("cancels the run that is still going", async () => {
    const workflows = stubWorkflows([snapshot({ runId: "wrun_live", status: "running" })]);
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.cancel_transcript?.execute({}, ctx);

    expect(workflows.cancel).toHaveBeenCalledWith("wrun_live");
    expect(result).toMatchObject({ cancelled: true, runId: "wrun_live" });
  });

  test("does not cancel a run that already finished", async () => {
    const workflows = stubWorkflows([completed()]);
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.cancel_transcript?.execute({}, ctx);

    expect(workflows.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: false, note: "Nothing is running." });
  });

  test("reports losing the race when the run settles mid-call", async () => {
    // `find` saw it running; by the time `cancel` landed it had completed.
    const workflows = stubWorkflows([snapshot({ status: "running" })], false);
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.cancel_transcript?.execute({}, ctx);
    expect(result).toMatchObject({ cancelled: false, note: "That one had already finished." });
  });
});

describe("the workflow body assembles the fan-out", () => {
  test("puts every chunk in the transcript in recording order", async () => {
    // "standup" is 7 characters, so the fixture gives it 8 chunks — two full
    // batches at CHUNK_CONCURRENCY 4, which is what makes the ordering claim
    // meaningful: a bug that appended batches out of order would show here.
    const out = await transcribeFlow({ recordingId: "standup", requestedBy: "caller" });

    expect(out.chunks).toBe(8);
    const starts = [...out.transcript.matchAll(/standup (\d+)s-/g)].map((m) => Number(m[1]));
    expect(starts).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
  });

  test("does not drop a partial final batch", async () => {
    // "intro" is 5 characters → 6 chunks, i.e. a batch of 4 and a batch of 2.
    const out = await transcribeFlow({ recordingId: "intro", requestedBy: "caller" });
    expect(out.chunks).toBe(6);
    expect(out.transcript).toContain("intro 300s-360s");
  });

  test("counts the words it actually assembled", async () => {
    const out = await transcribeFlow({ recordingId: "intro", requestedBy: "caller" });
    expect(out.words).toBe(out.transcript.split(/\s+/).filter(Boolean).length);
  });

  test("fails the run for an unknown recording rather than filing an empty transcript", async () => {
    await expect(transcribeFlow({ recordingId: "unknown", requestedBy: "caller" })).rejects.toThrow(
      /No recording named "unknown"/,
    );
  });
});
