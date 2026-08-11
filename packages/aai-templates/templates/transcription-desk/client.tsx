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
import { createWorkflowApi, isTerminal, page, useTheme, useWorkflowRun } from "@alexkroman1/aai-ui";
import { type CSSProperties, useState } from "react";

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
 * A style object that may also carry CSS custom properties.
 *
 * `CSSProperties` has no index signature, so a `--foo` key is a type error
 * without one — and the template-literal key keeps it fully checked rather than
 * admitting any string. The same shape `aai-ui`'s own `Button` uses.
 */
type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

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
  // The design-system palette (`aai-ui`'s `ThemeProvider`, installed by
  // `page()`). Read rather than hardcoded for the reason every other template
  // reads it: a `client({ theme })` override has to reach this page too, and a
  // literal `border-neutral-300` is a cool grey sitting on a warm cream page.
  const theme = useTheme();
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

  /*
   * A file input's button is a PSEUDO-ELEMENT (`::file-selector-button`), which
   * no inline `style` can reach — so the theme colors travel as custom
   * properties for the `file:` utilities below to read back. Left unstyled it is
   * native OS chrome, the one control on the page ignoring the design system.
   *
   * A NAMED binding rather than an inline literal: annotating it widens the type
   * before it reaches the `style` prop, and a fresh literal there would be
   * excess-property-checked against `CSSProperties`, which has no `--foo` key.
   */
  const inputVars: StyleWithVars = {
    "--desk-primary": theme.primary,
    "--desk-surface": theme.surface,
  };

  return (
    <main
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6 font-aai"
      style={{ color: theme.text }}
    >
      <header className="flex flex-col gap-1">
        <h1 className="m-0 font-aai-serif text-3xl font-semibold tracking-tight">
          Transcription Desk
        </h1>
        <p className="m-0 text-sm opacity-70">
          Pick a recording. It is split into {CHUNK_SECONDS}-second chunks in your browser and
          transcribed one chunk at a time — you can close this tab and come back to the run id.
        </p>
      </header>

      <label
        className="flex flex-col gap-3 rounded-aai border p-4"
        style={{ background: theme.surface, borderColor: theme.border }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[1.3px] opacity-60">
          Recording
        </span>
        <input
          type="file"
          accept="audio/*,video/*"
          disabled={busy}
          style={inputVars}
          className="text-sm file:mr-3 file:cursor-pointer file:rounded-aai file:border-0 file:bg-[var(--desk-primary)] file:px-3 file:py-2 file:text-[11px] file:font-semibold file:uppercase file:tracking-[1.3px] file:text-[var(--desk-surface)] disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submit(file);
          }}
        />
      </label>

      {progress && (
        <p className="m-0 text-sm opacity-70" role="status">
          {progress.phase === "decoding" && "Decoding audio…"}
          {progress.phase === "uploading" &&
            `Uploading chunk ${progress.done + 1} of ${progress.total}…`}
          {progress.phase === "starting" && "Starting the run…"}
        </p>
      )}

      {runId && !output && (
        <p className="m-0 text-sm opacity-70" role="status">
          Run <code className="font-aai-mono text-xs">{runId}</code> — {run?.status ?? "starting"}
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
          <h2 className="m-0 font-aai-serif text-xl font-semibold">{output.label}</h2>
          <p className="m-0 text-[11px] uppercase tracking-[1.3px] opacity-60">
            {output.words} words from {output.chunks} chunk(s)
          </p>
          <p
            className="m-0 whitespace-pre-wrap rounded-aai border p-4 text-sm leading-relaxed"
            style={{ background: theme.surface, borderColor: theme.border }}
          >
            {output.transcript}
          </p>
        </section>
      )}
    </main>
  );
}

page({ name: "Transcription Desk", component: App });
