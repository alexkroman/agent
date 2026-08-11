// Copyright 2026 the AAI authors. MIT license.
/**
 * A STATIC transcription app: upload a recording, get a transcript back.
 *
 * Two things make this the worked example for workflows, and they are separate:
 *
 * **1. The page is static, not a voice session.** `page: "static"` means this
 * agent serves no `/websocket` and no `/phone` — its front door is `client.tsx`,
 * an ordinary React page that POSTs to the workflow HTTP API. Nothing here
 * declares an STT/LLM/TTS pipeline, because nothing here holds a conversation.
 * (An agent that DOES hold one can still declare workflows — a tool calls
 * `ctx.workflows.start()` and answers its turn. The two are orthogonal.)
 *
 * **2. The work is chunked, and that is forced by the API being SYNCHRONOUS.**
 * AssemblyAI's Sync API returns a transcript in one request with no polling —
 * and accepts at most **120 seconds** of audio per call. So a 40-minute
 * recording is not one request, it is ~40 of them, and something has to hold the
 * partial result across all of them. That something is the journal: each chunk
 * is its own `ctx.step`, so a run that dies on chunk 27 resumes and replays 1–26
 * from the journal for free — no re-upload, no re-transcription, no re-billing —
 * and issues exactly one new request.
 *
 * **The audio never enters the journal.** Replay re-reads every step output, so
 * bytes in a step (or in the run input) would be re-read on every resume and
 * would blow the row cap. The page uploads each chunk to `/workflows/blobs`
 * instead and passes the ids; the run reads one with `ctx.blob()` inside the
 * step that needs it and releases it once transcribed.
 *
 * **Why the browser does the splitting.** The Sync API takes WAV or raw PCM
 * only, and the sandbox has no ffmpeg — but every browser has an audio decoder.
 * So `client.tsx` decodes whatever the user picked (mp3, m4a, wav…), downmixes
 * to 16 kHz mono, and slices it. See its header for that half.
 *
 * Requires storage (`aai storage enable`, or DATABASE_URL under `aai dev`) — the
 * journal and the uploads both live there.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";

/** The synchronous transcription endpoint — one request in, transcript out. */
const SYNC_URL = "https://sync.assemblyai.com/transcribe";

/** Model identifier the Sync API routes on. Required on every request. */
const SYNC_MODEL = "universal-3-5-pro";

/**
 * Sample rate the page resamples to before uploading.
 *
 * Declared on both sides (`client.tsx` has the same constant) because raw PCM
 * carries no header: the rate has to be sent in the request's `config` part, and
 * a mismatch is not an error — it is a transcript of audio played at the wrong
 * speed.
 */
const SAMPLE_RATE = 16_000;

/**
 * Chunks one run will accept.
 *
 * One journal entry per chunk plus the save, against the SDK's 500-entry cap —
 * and at 60 s per chunk this is over three hours of audio, past which the honest
 * answer is the async API rather than a longer journal.
 */
const MAX_CHUNKS = 200;

/**
 * Chunks transcribed at once.
 *
 * The chunks are independent, so transcribing them one at a time makes a
 * 40-minute recording take 40 round trips end to end for no reason. `ctx.step`
 * is safe to call concurrently — the journal is keyed per step, and naming each
 * one `chunk-<i>` (below) means the key is the chunk's POSITION rather than the
 * order the pool happened to reach it in.
 *
 * BOUNDED rather than a bare `Promise.all`, because the other end is a rate
 * limit: a long recording would otherwise open one request per chunk at once
 * and collect 429s, and a rate-limited chunk fails the run instead of waiting
 * its turn. Four is well inside any per-account limit and still turns those
 * 40 round trips into 10.
 */
const CHUNK_CONCURRENCY = 4;

/** What the Sync API answers with, narrowed to what this template reads. */
type SyncTranscript = { text?: string; confidence?: number; audio_duration_ms?: number };

const CREATE_TABLE = `create table if not exists transcripts (
  id bigserial primary key,
  run_id text not null unique,
  label text not null,
  transcript text not null,
  chunks int not null,
  created_at timestamptz not null default now()
)`;

/**
 * The REST API authenticates with the RAW key, not a `Bearer` token — a detail
 * that fails as a 401 rather than as a type error.
 */
function authHeader(env: Readonly<Record<string, string>>): string {
  const key = env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error("ASSEMBLYAI_API_KEY is not set for this app");
  return key;
}

/**
 * Transcribe an uploaded recording, chunk by chunk, and file the result.
 *
 * The step SET is a pure function of the input — one `chunk-<i>` per entry of
 * `blobIds`, plus the save — which is what makes replay deterministic. No
 * branch here reads a clock or a random value, and because each step is named
 * by its POSITION rather than disambiguated by call order, the chunks may be
 * transcribed in any order and by any number of workers without that changing.
 */
const transcribe = workflow({
  description: "Transcribe an uploaded recording by sending each chunk to the Sync API",
  input: z.object({
    /** Blob ids from `/workflows/blobs`, in playback order — see the module doc. */
    blobIds: z.array(z.string()).min(1).max(MAX_CHUNKS),
    /** Rate the chunks were resampled to. Raw PCM has no header to read it from. */
    sampleRate: z.number().int().positive().default(SAMPLE_RATE),
    label: z.string().default("recording").describe("What the user called this file"),
  }),
  async run({ blobIds, sampleRate, label }, ctx) {
    /**
     * Transcribe chunk `index` and release its audio.
     *
     * **The step is named by INDEX, and that is what makes the pool below
     * safe.** A bare `ctx.step("chunk", …)` is disambiguated by CALL ORDER, so
     * every concurrent caller has to be reasoned about: does the scheduler
     * really start them in `blobIds` order, on the first run AND on a replay
     * that skips the journaled ones? `chunk-3` needs no such argument — the
     * journal key IS the position, so a resume matches outputs to chunks by
     * construction however the pool happened to interleave them.
     */
    const transcribeChunk = async (blobId: string, index: number): Promise<string> => {
      // One step per chunk, and the step's OUTPUT is the text — small, and the
      // only thing a resume needs. A step that returned the audio would put it
      // in the journal, which is the whole failure this design avoids.
      const text = await ctx.step(`chunk-${index}`, async () => {
        const audio = await ctx.blob(blobId);
        // Gone means swept or already released: a run that resumes past the
        // blob TTL cannot make progress, so say which chunk rather than sending
        // an empty request and transcribing silence.
        if (!audio) throw new Error(`uploaded chunk ${blobId} is no longer available`);

        const form = new FormData();
        // `audio/pcm` is raw S16LE, which is what the page uploads — so the
        // rate and channel count must ride the `config` part; a WAV would carry
        // them in its own header instead. `ctx.blob` hands back bytes that own
        // their buffer, so they go straight into the part with no re-copy.
        form.append("audio", new Blob([audio.bytes], { type: "audio/pcm" }), "chunk.pcm");
        form.append(
          "config",
          new Blob([JSON.stringify({ sample_rate: sampleRate, channels: 1 })], {
            type: "application/json",
          }),
        );

        const resp = await fetch(SYNC_URL, {
          method: "POST",
          headers: { authorization: authHeader(ctx.env), "X-AAI-Model": SYNC_MODEL },
          body: form,
          // A drain aborts mid-chunk; the run resumes from the last recorded
          // chunk, so abandoning this request costs one chunk's work.
          signal: ctx.signal,
        });
        if (!resp.ok) {
          // The body carries `error_code` + `message` (or `detail` for auth and
          // rate limits), and it is the whole diagnostic — `audio_too_short`
          // reads very differently from `capacity_exceeded`, and the step's
          // retry only helps for the second.
          throw new Error(`sync transcribe failed: ${resp.status} ${await resp.text()}`);
        }
        const body = (await resp.json()) as SyncTranscript;
        return body.text ?? "";
      });

      // The chunk is transcribed, so its audio has served its purpose. Released
      // per chunk rather than in one pass at the end, so a long run is not
      // sitting on the whole recording while it works through it.
      //
      // Deliberately NOT inside the step above and deliberately NOT a step of
      // its own. Inside, it would delete the blob before the transcript was
      // journaled — and a crash in that window leaves a retry with nothing to
      // read, turning at-least-once into a run that can never finish. As its own
      // step it would double the journal for no benefit, since a replayed delete
      // is already a no-op (`releaseBlob` resolves false for a blob that is
      // gone).
      await ctx.releaseBlob(blobId);
      return text;
    };

    /**
     * Run `transcribeChunk` over every chunk, `CHUNK_CONCURRENCY` at a time.
     *
     * A shared cursor rather than slicing into batches: batches run at the
     * speed of their slowest member and leave workers idle at every boundary,
     * which on chunks whose durations vary is most of the win.
     *
     * A rejection propagates, which is deliberate — see the note below.
     */
    const parts: string[] = new Array<string>(blobIds.length).fill("");
    // The queue is built as pairs so a worker's loop condition is "was there an
    // item" rather than an index comparison — which keeps the body free of the
    // non-null assertion an `array[i]` read needs under
    // `noUncheckedIndexedAccess`.
    const queue = blobIds.map((blobId, index) => ({ blobId, index }));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, queue.length) }, async () => {
        for (let item = queue[next++]; item !== undefined; item = queue[next++]) {
          parts[item.index] = await transcribeChunk(item.blobId, item.index);
        }
      }),
    );

    // A failed chunk fails the RUN, and that is the durable half working rather
    // than a gap: every sibling that finished is already journaled under its own
    // `chunk-<i>`, so the resume replays those for free and re-issues only the
    // one that failed. Catching here to salvage a partial transcript would ship
    // a recording with a silent hole in it and call it a success.

    // Chunk boundaries fall mid-sentence, so the seam is a space: the Sync API
    // returns each chunk's own punctuation and inventing more (a newline, a
    // paragraph) would assert structure that is not in the audio.
    const transcript = parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");

    await ctx.step("save", async () => {
      await ctx.db.query(CREATE_TABLE);
      // `on conflict (run_id)` makes the write idempotent, which is the cheap
      // half of at-least-once: replaying this step cannot double-insert.
      await ctx.db.query(
        `insert into transcripts (run_id, label, transcript, chunks)
         values ($1, $2, $3, $4)
         on conflict (run_id) do update set transcript = excluded.transcript`,
        [ctx.runId, label, transcript, blobIds.length],
      );
      return { saved: ctx.runId };
    });

    // The return value is what `GET /workflows/runs/:id` reports as `output`,
    // so it is what the page renders — the transcript included, since a page
    // that had to query the database for it would need a second surface.
    return {
      label,
      chunks: blobIds.length,
      words: transcript.split(/\s+/).filter(Boolean).length,
      transcript,
    };
  },
});

export default agent({
  name: "Transcription Desk",

  // No voice: the page is a form, so `/websocket` and `/phone` are refused
  // rather than left listening on an app that declares no pipeline.
  page: "static",

  // The workflow reads this key directly, so declare it: the deploy checks that
  // every listed name is present, which turns a missing key into a deploy-time
  // error rather than a run that fails on its first chunk.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],

  workflows: { transcribe },
});
