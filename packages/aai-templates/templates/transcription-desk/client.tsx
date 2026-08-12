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
 * 3. **slice** on SILENCE, capped at `CHUNK_SECONDS`, and convert each to S16LE
 *    PCM. Silero VAD (`vad.ts`) says where the speech is and `chunker.ts`
 *    decides where to cut; a fixed window would land mid-word about half the
 *    time, and each side of that word is transcribed in isolation, so one bad
 *    boundary costs two wrong words. See `chunker.ts` for the rules.
 *
 * Each chunk is uploaded to `/workflows/blobs` — never inlined into the run
 * input, which is journaled and replayed (see `agent.ts`) — and the ids start one
 * run. From there the page is just polling `runId`, which is durable: closing the
 * tab does not cancel anything, and the same id can be read back with `curl`.
 */

import "@alexkroman1/aai-ui/styles.css";
import {
  createWorkflowApi,
  isTerminal,
  page,
  useTheme,
  useWorkflowRun,
  type WorkflowOutputOf,
} from "@alexkroman1/aai-ui";
import { type CSSProperties, useState } from "react";
// Type-only, so it is ERASED: naming the workflow costs this bundle nothing and
// keeps the page's idea of the output identical to the agent's by construction.
import type { transcribe } from "./agent.ts";
import { fixedChunks, MIN_SILENCE_MS, planChunks, type Span } from "./chunker.ts";
import { loadRuns, rememberRun } from "./runs.ts";
import { speechRegions } from "./vad.ts";

/**
 * Seconds of audio per request. The API's hard ceiling is 120; 60 leaves room
 * for the boundary rounding below and halves what one failed chunk costs.
 *
 * With silence-aware splitting this is the CAP rather than the size — most
 * chunks come in shorter, ending at the last pause that fits.
 */
const CHUNK_SECONDS = 60;

/** Must match `SAMPLE_RATE` in agent.ts — raw PCM carries no header. */
const SAMPLE_RATE = 16_000;

const api = createWorkflowApi();

/** Progress the page can honestly report while a run is in flight. */
type Progress = {
  phase: "decoding" | "detecting" | "uploading" | "starting";
  done: number;
  total: number;
};

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

/**
 * Split samples into chunks the API will accept, preferring silence.
 *
 * `subarray`, not `slice`: these are views onto the decoded audio, so a long
 * recording is not copied a second time just to be handed to `toPcm16`.
 *
 * A file shorter than one chunk still produces one — and the API's 80 ms floor
 * is what an empty (or near-empty) upload would trip, reported as
 * `audio_too_short` from inside the workflow rather than here.
 */
async function chunk(samples: Float32Array): Promise<Float32Array[]> {
  const maxSamples = CHUNK_SECONDS * SAMPLE_RATE;
  const speech = await speechRegions(samples, SAMPLE_RATE);
  const spans: Span[] =
    speech === undefined
      ? fixedChunks(samples.length, maxSamples)
      : planChunks(samples.length, speech, maxSamples, (MIN_SILENCE_MS / 1000) * SAMPLE_RATE);
  return spans.map((span) => samples.subarray(span.start, span.end));
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
  // `useState(loadRuns)` — the FUNCTION, not `loadRuns()`: passed as a lazy
  // initializer React calls once, where the call form would re-read storage and
  // re-parse the list on every render.
  const [runs, setRuns] = useState(loadRuns);
  // The type parameter is what makes `run.output` typed below, and it is DERIVED
  // from the workflow rather than restated — a second copy of the shape had
  // nothing checking the two agreed.
  const { run, error: pollError } = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, {
    api,
  });

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
      // Its own phase because it is its own wait: the first call downloads and
      // instantiates a ~14.7 MB WASM model, so a page reporting "decoding" here
      // would sit on that word for seconds with nothing explaining it.
      setProgress({ phase: "detecting", done: 0, total: 1 });
      const chunks = await chunk(samples);

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
      const started = await api.start("transcribe", {
        blobIds,
        sampleRate: SAMPLE_RATE,
        label: file.name,
      });
      // Remembered BEFORE it is shown, and that ordering is the whole point: from
      // this line on, the run is reachable even if the tab closes in the next
      // millisecond. Nothing else on this page holds the id.
      setRuns(rememberRun({ runId: started, label: file.name, startedAt: Date.now() }));
      setRunId(started);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(undefined);
    }
  }

  // No cast: `WorkflowRunSnapshot` is discriminated on `status`, so narrowing to
  // "completed" is what produces a typed `output`.
  const output = run?.status === "completed" ? run.output : undefined;

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
          Pick a recording. Your browser splits it where nobody is speaking (at most {CHUNK_SECONDS}
          s per chunk) and the chunks are transcribed in parallel. You can close this tab and come
          back to any run below.
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
          {progress.phase === "detecting" && "Finding pauses to split on…"}
          {progress.phase === "uploading" &&
            `Uploading chunk ${progress.done + 1} of ${progress.total}…`}
          {progress.phase === "starting" && "Starting the run…"}
        </p>
      )}

      {runId && !output && (
        <div className="flex items-center gap-3">
          <p className="m-0 text-sm opacity-70" role="status">
            Run <code className="font-aai-mono text-xs">{runId}</code> — {run?.status ?? "starting"}
            {run ? `, ${run.stepsCompleted} chunk(s) transcribed` : ""}
          </p>
          {/* A long recording is minutes of work the page cannot take back any
              other way: the run outlives this tab, so closing it abandons nothing.
              `cancel` is what actually stops it. Kept enabled until the run is
              terminal, and it never throws for a run that already finished — the
              route answers `cancelled: false` rather than failing. */}
          {!isTerminal(run) && (
            <button
              type="button"
              className="cursor-pointer rounded-aai border px-2 py-1 text-xs"
              style={{ background: theme.surface, borderColor: theme.border, color: theme.text }}
              onClick={() => {
                void api.cancel(runId).catch((err: unknown) => {
                  setFailure(err instanceof Error ? err.message : String(err));
                });
              }}
            >
              Stop
            </button>
          )}
        </div>
      )}

      {/* Three different failures, and they are not interchangeable: the browser
          half (decode/upload), the run itself, and a page that cannot read the
          run it started. Collapsing them would report a network blip as a failed
          transcription. */}
      {failure && <p className="m-0 text-sm text-red-700">Could not start: {failure}</p>}
      {run?.status === "failed" && (
        <p className="m-0 text-sm text-red-700">Transcription failed: {run.error}</p>
      )}
      {run?.status === "cancelled" && (
        <p className="m-0 text-sm opacity-70">Stopped. Nothing further will be charged.</p>
      )}
      {pollError && !output && (
        <p className="m-0 text-sm text-amber-700">Lost contact with the run — still retrying.</p>
      )}

      {/* The list is the point of a DURABLE run, not a convenience: a run
          outlives this tab, so the id is the only thing standing between the
          user and a finished transcript. Clicking one re-points the poll at it,
          which is the same code path a fresh page load takes — nothing is
          cached client-side, the answer comes from the server every time. */}
      {runs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[1.3px] opacity-60">
            Runs
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {runs.map((saved) => (
              <li key={saved.runId}>
                <button
                  type="button"
                  onClick={() => {
                    setFailure(undefined);
                    setRunId(saved.runId);
                  }}
                  // `aria-current` rather than colour alone — the active row has
                  // to be announced, not just tinted.
                  aria-current={saved.runId === runId ? "true" : undefined}
                  className="flex w-full cursor-pointer items-baseline gap-3 rounded-aai border px-3 py-2 text-left text-xs"
                  style={{
                    background: saved.runId === runId ? theme.bg : theme.surface,
                    borderColor: saved.runId === runId ? theme.primary : theme.border,
                    color: theme.text,
                  }}
                >
                  <span className="truncate font-medium">{saved.label}</span>
                  <span className="ml-auto shrink-0 font-aai-mono text-[10px] opacity-60">
                    {saved.runId.slice(0, 8)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
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
