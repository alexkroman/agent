// Copyright 2026 the AAI authors. MIT license.
/**
 * ffmpeg, callable from a step.
 *
 * A pipeline that touches audio hits the same wall on its first real file: the
 * recording is an `.m4a` off someone's phone, and every byte offset the
 * workflow does — cutting, planning a fan-out, reading a header — assumes
 * linear PCM. The transcription template's `parseWav` says so out loud, and its
 * remedy was a sentence telling the CALLER to run
 * `ffmpeg -i in.m4a -c:a pcm_s16le out.wav` on their own machine first. That is
 * the work the platform should be doing.
 *
 * So the guest image installs ffmpeg (`GUEST_SYSTEM_PACKAGES` in
 * aai-server/modal-harness-image.ts) and this module is how a step reaches it.
 * Three things, in the order a pipeline needs them:
 *
 * - {@link probeMedia} — what IS this file (duration, codec, sample rate).
 * - {@link transcodeToWav} — make it the one format the arithmetic works on.
 * - {@link runFfmpeg} — everything else, as an argv you build yourself.
 *
 * ```ts
 * import { stepReadUpload } from "@alexkroman1/aai/step";
 * import { probeMedia, transcodeToWav } from "@alexkroman1/aai/ffmpeg";
 *
 * export async function toPcm(uploadId: string) {
 *   const { bytes } = await stepReadUpload(uploadId);
 *   const info = await probeMedia(bytes);
 *   if (info.audio?.codec === "pcm_s16le") return bytes;
 *   return await transcodeToWav(bytes, { sampleRate: 16_000, channels: 1 });
 * }
 * ```
 *
 * ## Why the runner is ours
 *
 * Every ffmpeg wrapper on npm ships one of these, and none of them survives
 * this repo's rules: unbounded `stdout`/`stderr` buffers (a 100 MB
 * `execFileSync` cap is a documented default in one of them), no
 * `AbortSignal`, no timeout, and a killed child reported as an ordinary
 * failure. What a guest step needs instead is exactly four properties, and they
 * are the whole content of `spawnFfmpeg`, this module's internal runner:
 *
 * 1. **Bounded output.** stderr is kept as a TAIL
 *    (4000 chars) because ffmpeg's log is progress lines
 *    and the diagnosis is the last one; stdout is capped
 *    (64 MiB) and exceeding it kills the child
 *    rather than the container — a guest is sized in hundreds of MiB, and an
 *    hour of 16 kHz mono PCM is ~115 MB, so "buffer whatever comes" is a
 *    decision to fall over on a long recording.
 * 2. **Abortable, on a deadline.** One `AbortSignal.any` of the caller's signal
 *    and `AbortSignal.timeout` — no `Promise.race` against a timer
 *    (`guard-invariants` rule 3), and no timer that outlives the child
 *    (`AbortSignal.timeout` is unref'd, verified).
 * 3. **A failure that says which kind it is.** {@link FfmpegError.kind}
 *    separates the four outcomes a caller treats differently, which matters
 *    most inside a workflow: a `timeout` is worth retrying and an `exit` on a
 *    corrupt file never is, so the step classifies with
 *    `throwStepError`/`throwFatalStepError` instead of retrying a file that
 *    will fail identically forever.
 * 4. **A missing binary that names its remedy.** ENOENT here means `aai dev` on
 *    a laptop without ffmpeg — the deployed guest always has it — so the error
 *    says how to install one instead of reporting `spawn ffmpeg ENOENT`.
 *
 * ## The argv is yours
 *
 * {@link runFfmpeg} passes `args` through VERBATIM. It adds no `-y`, no
 * `-hide_banner`, no `-loglevel`: the argv in {@link FfmpegError.argv} is then
 * the command that ran, which is the thing you paste into a shell to reproduce
 * a failure. The standing flags live in the two convenience functions, which
 * are where a policy belongs.
 *
 * ## Bytes or a path
 *
 * Both take a {@link FfmpegSource}: a path string, or bytes piped in on `pipe:0`.
 * Bytes are what a step HAS (`stepReadUpload` answers with them), so they are the
 * default shape here — but piping is not free of caveats, and they are the
 * caller's to know: a format whose index lives at the END of the file (a
 * non-faststart MP4) cannot be read from a pipe, and ffmpeg says so. Write those
 * to a temp file and pass the path. Large media should go file → file anyway:
 * nothing is buffered then, and `output` in an argv you build yourself is the
 * whole difference.
 *
 * @module ffmpeg
 */

import { omitUndefined } from "../sdk/omit-undefined.ts";
import { type MediaInfo, parseProbeJson } from "./_ffmpeg-json.ts";
import {
  FFMPEG_PATH_ENV,
  FFPROBE_PATH_ENV,
  type FfmpegRunOptions,
  type FfmpegRunResult,
  resolveBinary,
  spawnFfmpeg,
} from "./_ffmpeg-spawn.ts";

export type { MediaInfo, MediaStreamInfo } from "./_ffmpeg-json.ts";
export {
  FfmpegError,
  type FfmpegFailureKind,
  type FfmpegRunOptions,
  type FfmpegRunResult,
  isFfmpegError,
} from "./_ffmpeg-spawn.ts";

/** A media input: a filesystem path, or the bytes themselves. */
export type FfmpegSource = string | Uint8Array;

/**
 * The standing flags every ffmpeg invocation in a guest wants, before anything
 * the caller is actually asking for.
 *
 * Five spellings of this existed — four in templates, one here in
 * {@link transcodeToWav} — and they disagreed on the two that matter:
 *
 * - **`-nostats` is not cosmetic.** A failing run is diagnosed from the stderr
 *   this package captures, and it keeps only the last
 *   `FFMPEG_STDERR_TAIL_CHARS` of it. ffmpeg writes a progress line several
 *   times a second, so on anything long the progress spam is what survives and
 *   the error that explains the failure is what gets evicted. Only one of the
 *   five passed it.
 * - **`-nostdin` is about the runtime, not the job.** In a guest there is no
 *   terminal, and an ffmpeg that decides to read stdin is a process that never
 *   exits. That is a fact about where this SDK runs, so it belongs here rather
 *   than in each caller's argv.
 *
 * `-y` overwrites the output without asking, which is right for both shapes a
 * step uses — a temp file it just named, or `pipe:1`.
 *
 * `loglevel` defaults to `"error"`. Pass `"info"` for a filter that reports
 * through the LOG rather than to a file — `loudnorm`'s `print_format=json` is
 * the case, and at `error` that pass runs, succeeds, and prints nothing.
 *
 * **ffprobe takes none of this.** It rejects `-nostdin` and `-nostats`
 * outright, so {@link probeMedia} builds its own argv and this helper is for
 * ffmpeg only.
 *
 * @example
 * ```ts
 * import { ffmpegBaseArgs, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
 *
 * await runFfmpeg([...ffmpegBaseArgs(), "-i", "/tmp/in.m4a", "/tmp/out.wav"]);
 * await runFfmpeg([...ffmpegBaseArgs({ loglevel: "info" }), "-i", "/tmp/in.wav", "-f", "null", "-"]);
 * ```
 *
 * @public
 */
export function ffmpegBaseArgs(options: { loglevel?: string } = {}): string[] {
  return ["-hide_banner", "-loglevel", options.loglevel ?? "error", "-nostats", "-nostdin", "-y"];
}

/**
 * Run ffmpeg with `args`, exactly as given.
 *
 * Resolves only on a zero exit; every other outcome is a {@link FfmpegError}
 * naming its {@link FfmpegFailureKind}.
 *
 * @example
 * ```ts
 * import { ffmpegBaseArgs, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
 *
 * // File to file: nothing is buffered, so this is the shape for long media.
 * await runFfmpeg([
 *   ...ffmpegBaseArgs(),
 *   "-i", "/tmp/in.m4a",
 *   "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
 *   "/tmp/out.wav",
 * ]);
 * ```
 */
export function runFfmpeg(
  args: readonly string[],
  opts: FfmpegRunOptions = {},
): Promise<FfmpegRunResult> {
  return spawnFfmpeg(resolveBinary(FFMPEG_PATH_ENV, "FFMPEG_PATH", "ffmpeg", opts.binary), args, {
    ...opts,
    installHint: "ffmpeg",
    pathEnv: FFMPEG_PATH_ENV,
  });
}

export type ProbeOptions = Omit<FfmpegRunOptions, "stdin" | "binary"> & {
  /** The `ffprobe` binary. Defaults to `AAI_FFPROBE_PATH`, `FFPROBE_PATH`, then `ffprobe`. */
  binary?: string;
};

/**
 * What ffprobe makes of a file: duration, container, and every stream.
 *
 * ```ts
 * import { probeMedia } from "@alexkroman1/aai/ffmpeg";
 *
 * const info = await probeMedia("/tmp/recording.m4a");
 * const seconds = info.durationSec ?? 0;
 * const needsTranscode = info.audio?.codec !== "pcm_s16le";
 * ```
 *
 * A field ffprobe did not report comes back `undefined` rather than zero — see
 * `_ffmpeg-json.ts` for why that distinction is load-bearing. Reading a
 * duration off a PIPE is the one case worth knowing about: for a format whose
 * duration lives in a trailing index, ffprobe cannot seek to it and answers
 * `undefined`, where the same file on disk answers exactly.
 */
export async function probeMedia(
  source: FfmpegSource,
  opts: ProbeOptions = {},
): Promise<MediaInfo> {
  const { input, stdin } = sourceArgs(source);
  const { stdout } = await spawnFfmpeg(
    resolveBinary(FFPROBE_PATH_ENV, "FFPROBE_PATH", "ffprobe", opts.binary),
    [
      "-hide_banner",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      input,
    ],
    {
      ...opts,
      ...omitUndefined({ stdin }),
      installHint: "ffprobe (part of the ffmpeg package)",
      // Named by the CALLER, so a `binary: "/opt/ffprobe"` override still
      // points at the variable that would have found it — deriving the name
      // from the resolved path only worked for the two bare defaults.
      pathEnv: FFPROBE_PATH_ENV,
    },
  );
  return parseProbeJson(Buffer.from(stdout).toString("utf-8"));
}

export type WavEncodeOptions = {
  /** Output sample rate. Omit to keep the input's. */
  sampleRate?: number;
  /** Output channel count. Omit to keep the input's. 1 is what STT wants. */
  channels?: number;
  /** Sample width, 16 or 24 or 32 bits. Defaults to 16. */
  bitsPerSample?: 16 | 24 | 32;
};

/**
 * The encoder half of a linear-PCM WAV argv — no input, no output.
 *
 * Exported because the in-memory {@link transcodeToWav} is the wrong shape for
 * a long recording, and a caller writing file → file should not have to
 * re-derive which of ffmpeg's codec names is uncompressed:
 *
 * ```ts no-check
 * import { runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
 *
 * await runFfmpeg([
 *   "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
 *   "-i", inputPath,
 *   ...wavEncodeArgs({ sampleRate: 16_000, channels: 1 }),
 *   outputPath,
 * ]);
 * ```
 */
export function wavEncodeArgs(opts: WavEncodeOptions = {}): string[] {
  const bits = opts.bitsPerSample ?? 16;
  return [
    "-vn",
    "-c:a",
    `pcm_s${bits}le`,
    ...(opts.channels === undefined ? [] : ["-ac", String(opts.channels)]),
    ...(opts.sampleRate === undefined ? [] : ["-ar", String(opts.sampleRate)]),
    "-f",
    "wav",
  ];
}

export type TranscodeToWavOptions = WavEncodeOptions & Omit<FfmpegRunOptions, "stdin">;

/**
 * Re-encode anything ffmpeg can read into linear-PCM WAV bytes.
 *
 * The conversion a transcription pipeline needs, because cutting a recording by
 * byte offset is only arithmetic on uncompressed audio. Video is dropped.
 *
 * The result is held in memory, so it is capped like any other piped output
 * (64 MiB) — about an hour of 16 kHz mono
 * at the default. Past that, go file → file with {@link wavEncodeArgs}.
 *
 * Note WAV written to a PIPE carries a placeholder length in its header:
 * ffmpeg cannot seek back to patch it once the size is known. Every decoder
 * treats it as "read to EOF", and this repo's own `parseWav` intersects the
 * declared length with the real byte count for exactly that reason — but code
 * that trusts the header's `data` size will read zero samples.
 */
export async function transcodeToWav(
  source: FfmpegSource,
  opts: TranscodeToWavOptions = {},
): Promise<Uint8Array> {
  const { input, stdin } = sourceArgs(source);
  const { stdout } = await runFfmpeg(
    [...ffmpegBaseArgs(), "-i", input, ...wavEncodeArgs(opts), "pipe:1"],
    { ...opts, ...omitUndefined({ stdin }) },
  );
  return stdout;
}

/** A {@link FfmpegSource} as the argv token that reads it, plus any stdin bytes. */
function sourceArgs(source: FfmpegSource): { input: string; stdin?: Uint8Array } {
  return typeof source === "string" ? { input: source } : { input: "pipe:0", stdin: source };
}
