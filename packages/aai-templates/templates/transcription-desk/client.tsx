// Copyright 2026 the AAI authors. MIT license.
/**
 * The static page: pick a recording, watch it transcribe.
 *
 * This file owns the SPLITTING, and that is a deliberate division of labour
 * rather than convenience. The Sync API accepts at most 120 seconds per request
 * and only WAV or raw PCM — while the file a user picks is an mp3, an m4a, a
 * video's audio track. Decoding that needs a codec, the sandbox has no ffmpeg,
 * and every browser ships one behind `decodeAudioData`. So the browser is the
 * only place that can turn "a file" into "chunks the API accepts", and it does
 * three things in order:
 *
 * 1. **decode** — any container/codec the browser knows → float samples.
 * 2. **downmix + resample** to 16 kHz mono, through an `OfflineAudioContext`
 *    (which does both correctly, band-limited; hand-rolled decimation aliases).
 * 3. **slice** into `CHUNK_SECONDS` windows and convert each to S16LE PCM.
 *
 * Each chunk is uploaded to `/workflows/blobs` — never inlined into the run
 * input, which is journaled and replayed (see `agent.ts`) — and the ids start one
 * run. From there the page is just polling `runId`, which is durable: closing the
 * tab does not cancel anything, and the same id can be read back with `curl`.
 */

import "@alexkroman1/aai-ui/styles.css";
import { createWorkflowApi, isTerminal, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import { useState } from "react";

/**
 * Seconds of audio per request. The API's hard ceiling is 120; 60 leaves room
 * for the boundary rounding below and halves what one failed chunk costs.
 */
const CHUNK_SECONDS = 60;

/** Must match `SAMPLE_RATE` in agent.ts — raw PCM carries no header. */
const SAMPLE_RATE = 16_000;

const api = createWorkflowApi();

/** What the run's `output` looks like once it completes (see agent.ts). */
type TranscribeOutput = {
  label: string;
  chunks: number;
  words: number;
  transcript: string;
};

/** Progress the page can honestly report while a run is in flight. */
type Progress = { phase: "decoding" | "uploading" | "starting"; done: number; total: number };

/**
 * Decode, downmix and resample a picked file to 16 kHz mono float samples.
 *
 * `OfflineAudioContext` is doing the real work: constructed at the target rate
 * and channel count, rendering through it resamples and downmixes in one pass
 * with a proper band-limited filter. Decimating by hand would fold everything
 * above 8 kHz back into the speech band, which does not sound like a bug — it
 * sounds like a bad phone line, and it reaches the transcript as wrong words.
 */
async function toMonoSamples(file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  // A plain AudioContext for decoding only: it knows the browser's codecs, and
  // decoding is independent of the rate we render at. Closed immediately — a
  // page that decodes several files would otherwise hold one context per file.
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(bytes);
  } finally {
    void decoder.close();
  }

  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Convert float samples in [-1, 1] to signed 16-bit little-endian PCM.
 *
 * Clamped before scaling: a float slightly outside the range (which resampling
 * legitimately produces) would otherwise wrap around to the opposite extreme and
 * arrive as a click.
 */
function toPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  // The buffer is NAMED rather than inlined so the returned view's type carries
  // `ArrayBuffer`: a `Blob` part (which is where these bytes end up) rejects a
  // view over an unknown buffer kind, and `DataView.buffer` is only `ArrayBufferLike`.
  const buffer = new ArrayBuffer(samples.length * 2);
  const out = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(i * 2, Math.round(clamped * 32_767), true);
  }
  return new Uint8Array(buffer);
}

/** Split samples into `CHUNK_SECONDS` windows — the manual chunking. */
function chunk(samples: Float32Array): Float32Array[] {
  const perChunk = CHUNK_SECONDS * SAMPLE_RATE;
  const chunks: Float32Array[] = [];
  for (let start = 0; start < samples.length; start += perChunk) {
    chunks.push(samples.subarray(start, Math.min(start + perChunk, samples.length)));
  }
  // A file shorter than one chunk still has to produce one — and the API's
  // 80 ms floor is what an empty (or near-empty) upload would trip, reported as
  // `audio_too_short` from inside the workflow rather than here.
  return chunks;
}

function App() {
  const [runId, setRunId] = useState<string>();
  const [progress, setProgress] = useState<Progress>();
  const [failure, setFailure] = useState<string>();
  const { run, error: pollError } = useWorkflowRun(runId, { api });

  // Busy through the browser-side work AND while a started run is still going.
  // `isTerminal` is the SDK's own answer to "will this change again", so the two
  // cannot drift.
  const busy = progress !== undefined || (runId !== undefined && !isTerminal(run));

  async function submit(file: File): Promise<void> {
    setFailure(undefined);
    setRunId(undefined);
    try {
      setProgress({ phase: "decoding", done: 0, total: 1 });
      const samples = await toMonoSamples(file);
      const chunks = chunk(samples);

      // Uploaded one at a time rather than with `Promise.all`: a long recording
      // is dozens of multi-megabyte POSTs, and firing them together is how a
      // page saturates its own uplink and starts timing out. Sequential also
      // makes the progress count honest.
      const blobIds: string[] = [];
      for (const [index, part] of chunks.entries()) {
        setProgress({ phase: "uploading", done: index, total: chunks.length });
        const { blobId } = await api.upload(toPcm16(part), "audio/pcm");
        blobIds.push(blobId);
      }

      setProgress({ phase: "starting", done: chunks.length, total: chunks.length });
      // Resolves as soon as the run is journaled — the transcription itself
      // continues without this page, which is why only the id is kept.
      setRunId(
        await api.start("transcribe", { blobIds, sampleRate: SAMPLE_RATE, label: file.name }),
      );
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(undefined);
    }
  }

  const output = run?.status === "completed" ? (run.output as TranscribeOutput) : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-semibold">Transcription Desk</h1>
        <p className="m-0 text-sm text-neutral-600">
          Pick a recording. It is split into {CHUNK_SECONDS}-second chunks in your browser and
          transcribed one chunk at a time — you can close this tab and come back to the run id.
        </p>
      </header>

      <label className="flex flex-col gap-2 rounded-lg border border-neutral-300 bg-white p-4">
        <span className="text-sm font-medium">Recording</span>
        <input
          type="file"
          accept="audio/*,video/*"
          disabled={busy}
          className="text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submit(file);
          }}
        />
      </label>

      {progress && (
        <p className="m-0 text-sm text-neutral-700" role="status">
          {progress.phase === "decoding" && "Decoding audio…"}
          {progress.phase === "uploading" &&
            `Uploading chunk ${progress.done + 1} of ${progress.total}…`}
          {progress.phase === "starting" && "Starting the run…"}
        </p>
      )}

      {runId && !output && (
        <p className="m-0 text-sm text-neutral-700" role="status">
          Run <code className="font-mono text-xs">{runId}</code> — {run?.status ?? "starting"}
          {run ? `, ${run.stepsCompleted} chunk(s) transcribed` : ""}
        </p>
      )}

      {/* Three different failures, and they are not interchangeable: the browser
          half (decode/upload), the run itself, and a page that cannot read the
          run it started. Collapsing them would report a network blip as a failed
          transcription. */}
      {failure && <p className="m-0 text-sm text-red-700">Could not start: {failure}</p>}
      {run?.status === "failed" && (
        <p className="m-0 text-sm text-red-700">Transcription failed: {run.error}</p>
      )}
      {pollError && !output && (
        <p className="m-0 text-sm text-amber-700">Lost contact with the run — still retrying.</p>
      )}

      {output && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-lg font-medium">{output.label}</h2>
          <p className="m-0 text-xs text-neutral-600">
            {output.words} words from {output.chunks} chunk(s)
          </p>
          <p className="m-0 whitespace-pre-wrap rounded-lg border border-neutral-300 bg-white p-4 text-sm leading-relaxed">
            {output.transcript}
          </p>
        </section>
      )}
    </main>
  );
}

page({ name: "Transcription Desk", component: App });
