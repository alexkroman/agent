// Copyright 2026 the AAI authors. MIT license.
/**
 * Workflow behaviour for the transcription-desk template.
 *
 * What this template has to get right is the CHUNK LOOP and the contract with
 * the Sync API: one request per uploaded chunk, the rate and channel count sent
 * alongside raw PCM (which carries no header), each chunk's audio released once
 * its text is journaled, and the parts stitched in order. The engine's own
 * semantics — replay, per-step retry, lease recovery, durable sleep — belong to
 * `packages/aai/host/workflow-engine.test.ts`; asserting them here would be
 * testing the SDK through a template.
 *
 * `page: "static"` is asserted too, because it is what makes this a page rather
 * than a voice agent: flip it and the app starts serving `/websocket` with no
 * pipeline behind it.
 */

import type { Db, WorkflowContext } from "@alexkroman1/aai";
import { createWorkflowContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";

/** The one workflow this template declares, narrowed once for every spec. */
const transcribe = agentDef.workflows?.transcribe;

/** A `Db` that swallows DDL/inserts and records the statements it saw. */
function makeDb(): Db & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: <T>(statement: string): Promise<T[]> => {
      sql.push(statement);
      return Promise.resolve([] as T[]);
    },
  };
}

/**
 * A fake blob store: `n` chunks of silence, each distinguishable by length.
 *
 * Typed by `Pick`ing the real context's two members rather than restating their
 * signatures — the restated `blob` had already drifted from `WorkflowContext`'s
 * (which promises bytes that own their `ArrayBuffer`), and a fake that promises
 * less than the real thing is a fake a spec cannot trust.
 */
function makeBlobs(sizes: number[]): Pick<WorkflowContext, "blob" | "releaseBlob"> & {
  released: string[];
} {
  const released: string[] = [];
  const bytesById = new Map(sizes.map((size, i) => [`blob-${i}`, new Uint8Array(size)]));
  return {
    released,
    blob: (id) => {
      const bytes = bytesById.get(id);
      return Promise.resolve(bytes ? { contentType: "audio/pcm", bytes } : undefined);
    },
    releaseBlob: (id) => {
      released.push(id);
      return Promise.resolve(bytesById.delete(id));
    },
  };
}

/**
 * A `fetch` answering every Sync request with `text`, recording the requests.
 *
 * The recorder is a `Request` per call rather than the raw arguments, because
 * what the specs assert on is the request as the API receives it — its headers
 * and its multipart body — and `Request` is what parses those.
 */
function makeSyncFetch(texts: string[]): { fetch: typeof globalThis.fetch; calls: Request[] } {
  let n = 0;
  const calls: Request[] = [];
  const impl: typeof globalThis.fetch = (input, init) => {
    calls.push(new Request(input, init));
    const text = texts[n++] ?? "";
    return Promise.resolve(
      new Response(JSON.stringify({ text, confidence: 0.9, audio_duration_ms: 1000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetch: impl, calls };
}

const ENV = { ASSEMBLYAI_API_KEY: "test-key" };

describe("transcription-desk", () => {
  test("the template declares a static page, not a voice agent", () => {
    // The whole point of the template: no pipeline, no session, a form instead.
    expect(agentDef.page).toBe("static");
    expect(agentDef.workflows).toHaveProperty("transcribe");
    // No tools — the LLM never selects a workflow, and there is no turn here to
    // select one in.
    expect(Object.keys(agentDef.tools ?? {})).toEqual([]);
  });

  test("declares the key the workflow reads, so a deploy catches its absence", () => {
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });

  test("sends one Sync request per chunk and stitches the parts in order", async () => {
    const sync = makeSyncFetch(["Hello there.", "Second part.", "And the end."]);
    vi.stubGlobal("fetch", sync.fetch);
    const blobs = makeBlobs([320, 320, 320]);
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...blobs });

    const output = (await transcribe?.run(
      { blobIds: ["blob-0", "blob-1", "blob-2"], sampleRate: 16_000, label: "call.mp3" },
      ctx,
    )) as { transcript: string; chunks: number; words: number };

    expect(sync.calls).toHaveLength(3);
    expect(output.transcript).toBe("Hello there. Second part. And the end.");
    expect(output.chunks).toBe(3);
    expect(output.words).toBe(7);
    // One journaled step per chunk plus the save — the shape MAX_CHUNKS is
    // sized against. A release step here would double the journal.
    //
    // Named by POSITION rather than all `chunk`: the chunks are transcribed
    // concurrently, and a bare name is disambiguated by CALL ORDER, so the
    // journal key would depend on how the pool interleaved them. `chunk-<i>`
    // means a resume matches each output to its own chunk by construction.
    expect(ctx.steps).toEqual(["chunk-0", "chunk-1", "chunk-2", "save"]);
  });

  test("transcribes chunks concurrently, bounded, and still stitches them in order", async () => {
    // The pool is what makes a long recording usable — serial, a 40-chunk file
    // is 40 round trips end to end. Both halves are asserted: that requests
    // really overlap, and that overlapping cannot reorder the transcript.
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      const index = n++;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Later chunks answer FIRST, so a transcript assembled in completion
      // order would come back reversed.
      await new Promise((resolve) => setTimeout(resolve, (8 - index) * 5));
      inFlight -= 1;
      order.push(index);
      return Response.json({ text: `part${index}` });
    });
    const blobIds = Array.from({ length: 8 }, (_, i) => `blob-${i}`);
    const ctx = createWorkflowContext({
      env: ENV,
      db: makeDb(),
      ...makeBlobs(blobIds.map(() => 320)),
    });

    const output = (await transcribe?.run(
      { blobIds, sampleRate: 16_000, label: "long.mp3" },
      ctx,
    )) as { transcript: string };

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    // The generator really did settle out of order, so the ordering assertion
    // below is exercising something.
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
    expect(output.transcript).toBe("part0 part1 part2 part3 part4 part5 part6 part7");
  });

  test("sends the raw key and the model header, not a Bearer token", async () => {
    const sync = makeSyncFetch(["ok"]);
    vi.stubGlobal("fetch", sync.fetch);
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...makeBlobs([320]) });

    await transcribe?.run({ blobIds: ["blob-0"], sampleRate: 16_000, label: "x" }, ctx);

    const request = sync.calls[0];
    expect(request?.url).toBe("https://sync.assemblyai.com/transcribe");
    // A `Bearer ` prefix here fails as a 401 at run time rather than as a type
    // error, which is exactly why it is pinned.
    expect(request?.headers.get("authorization")).toBe("test-key");
    expect(request?.headers.get("x-aai-model")).toBe("universal-3-5-pro");
  });

  test("sends the sample rate alongside the PCM, which has no header to carry it", async () => {
    const sync = makeSyncFetch(["ok"]);
    vi.stubGlobal("fetch", sync.fetch);
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...makeBlobs([320]) });

    await transcribe?.run({ blobIds: ["blob-0"], sampleRate: 24_000, label: "x" }, ctx);

    const form = await sync.calls[0]?.formData();
    const config = form?.get("config");
    expect(config).toBeInstanceOf(Blob);
    // Wrong rate here is not an error — it is a transcript of audio at the wrong
    // speed, so the value has to travel and has to be the one the page used.
    expect(JSON.parse(await (config as Blob).text())).toEqual({
      sample_rate: 24_000,
      channels: 1,
    });
    expect(form?.get("audio")).toBeInstanceOf(Blob);
  });

  test("releases each chunk's audio after its text is journaled", async () => {
    vi.stubGlobal("fetch", makeSyncFetch(["a", "b"]).fetch);
    const blobs = makeBlobs([320, 320]);
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...blobs });

    await transcribe?.run({ blobIds: ["blob-0", "blob-1"], sampleRate: 16_000, label: "x" }, ctx);

    // Both released, and in chunk order — a long run must not sit on the whole
    // recording while it works through it.
    expect(blobs.released).toEqual(["blob-0", "blob-1"]);
  });

  test("names the missing chunk when an upload has been swept", async () => {
    vi.stubGlobal("fetch", makeSyncFetch(["never reached"]).fetch);
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...makeBlobs([]) });

    // Reported by id rather than sending an empty request and transcribing
    // silence, which is what makes a resume past the blob TTL diagnosable.
    await expect(
      transcribe?.run({ blobIds: ["blob-0"], sampleRate: 16_000, label: "x" }, ctx),
    ).rejects.toThrow(/blob-0 is no longer available/);
  });

  test("fails with the API's own body, which is the whole diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error_code: "audio_too_short", message: "80ms min" }), {
            status: 400,
          }),
        ),
      ),
    );
    const ctx = createWorkflowContext({ env: ENV, db: makeDb(), ...makeBlobs([2]) });

    // `audio_too_short` and `capacity_exceeded` want different responses from a
    // human, and only the body distinguishes them.
    await expect(
      transcribe?.run({ blobIds: ["blob-0"], sampleRate: 16_000, label: "x" }, ctx),
    ).rejects.toThrow(/audio_too_short/);
  });

  test("refuses to run without the provider key", async () => {
    vi.stubGlobal("fetch", makeSyncFetch(["unused"]).fetch);
    const ctx = createWorkflowContext({ env: {}, db: makeDb(), ...makeBlobs([320]) });

    await expect(
      transcribe?.run({ blobIds: ["blob-0"], sampleRate: 16_000, label: "x" }, ctx),
    ).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("stores the transcript idempotently, keyed by run id", async () => {
    vi.stubGlobal("fetch", makeSyncFetch(["stored"]).fetch);
    const db = makeDb();
    const ctx = createWorkflowContext({ env: ENV, db, ...makeBlobs([320]) });

    await transcribe?.run({ blobIds: ["blob-0"], sampleRate: 16_000, label: "x" }, ctx);

    // At-least-once means the save step can run twice, so the write itself has
    // to absorb it.
    expect(db.sql.some((s) => s.includes("on conflict (run_id) do update"))).toBe(true);
  });
});
