# ffmpeg

ffmpeg, callable from a step.

A pipeline that touches audio hits the same wall on its first real file: the
recording is an `.m4a` off someone's phone, and every byte offset the
workflow does — cutting, planning a fan-out, reading a header — assumes
linear PCM. The transcription template's `parseWav` says so out loud, and its
remedy was a sentence telling the CALLER to run
`ffmpeg -i in.m4a -c:a pcm_s16le out.wav` on their own machine first. That is
the work the platform should be doing.

So the guest image installs ffmpeg (`GUEST_SYSTEM_PACKAGES` in
aai-server/modal-harness-image.ts) and this module is how a step reaches it.
Three things, in the order a pipeline needs them:

- [probeMedia](#probemedia) — what IS this file (duration, codec, sample rate).
- [transcodeToWav](#transcodetowav) — make it the one format the arithmetic works on.
- [runFfmpeg](#runffmpeg) — everything else, as an argv you build yourself.

```ts
import { stepReadUpload } from "@alexkroman1/aai/step";
import { probeMedia, transcodeToWav } from "@alexkroman1/aai/ffmpeg";

export async function toPcm(uploadId: string) {
  const { bytes } = await stepReadUpload(uploadId);
  const info = await probeMedia(bytes);
  if (info.audio?.codec === "pcm_s16le") return bytes;
  return await transcodeToWav(bytes, { sampleRate: 16_000, channels: 1 });
}
```

## Why the runner is ours

Every ffmpeg wrapper on npm ships one of these, and none of them survives
this repo's rules: unbounded `stdout`/`stderr` buffers (a 100 MB
`execFileSync` cap is a documented default in one of them), no
`AbortSignal`, no timeout, and a killed child reported as an ordinary
failure. What a guest step needs instead is exactly four properties, and they
are the whole content of `spawnFfmpeg`, this module's internal runner:

1. **Bounded output.** stderr is kept as a TAIL
   (4000 chars) because ffmpeg's log is progress lines
   and the diagnosis is the last one; stdout is capped
   (64 MiB) and exceeding it kills the child
   rather than the container — a guest is sized in hundreds of MiB, and an
   hour of 16 kHz mono PCM is ~115 MB, so "buffer whatever comes" is a
   decision to fall over on a long recording.
2. **Abortable, on a deadline.** One `AbortSignal.any` of the caller's signal
   and `AbortSignal.timeout` — no `Promise.race` against a timer
   (`guard-invariants` rule 3), and no timer that outlives the child
   (`AbortSignal.timeout` is unref'd, verified).
3. **A failure that says which kind it is.** [FfmpegError.kind](#kind)
   separates the four outcomes a caller treats differently, which matters
   most inside a workflow: a `timeout` is worth retrying and an `exit` on a
   corrupt file never is, so the step classifies with
   `throwStepError`/`throwFatalStepError` instead of retrying a file that
   will fail identically forever.
4. **A missing binary that names its remedy.** ENOENT here means `aai dev` on
   a laptop without ffmpeg — the deployed guest always has it — so the error
   says how to install one instead of reporting `spawn ffmpeg ENOENT`.

## The argv is yours

[runFfmpeg](#runffmpeg) passes `args` through VERBATIM. It adds no `-y`, no
`-hide_banner`, no `-loglevel`: the argv in [FfmpegError.argv](#argv) is then
the command that ran, which is the thing you paste into a shell to reproduce
a failure. The standing flags live in the two convenience functions, which
are where a policy belongs.

## Bytes or a path

Both take a [FfmpegSource](#ffmpegsource): a path string, or bytes piped in on `pipe:0`.
Bytes are what a step HAS (`stepReadUpload` answers with them), so they are the
default shape here — but piping is not free of caveats, and they are the
caller's to know: a format whose index lives at the END of the file (a
non-faststart MP4) cannot be read from a pipe, and ffmpeg says so. Write those
to a temp file and pass the path. Large media should go file → file anyway:
nothing is buffered then, and `output` in an argv you build yourself is the
whole difference.

## Functions

### ffmpegBaseArgs()

```ts
function ffmpegBaseArgs(options?: {
  loglevel?: string;
}): string[];
```

The standing flags every ffmpeg invocation in a guest wants, before anything
the caller is actually asking for.

Five spellings of this existed — four in templates, one here in
[transcodeToWav](#transcodetowav) — and they disagreed on the two that matter:

- **`-nostats` is not cosmetic.** A failing run is diagnosed from the stderr
  this package captures, and it keeps only the last
  `FFMPEG_STDERR_TAIL_CHARS` of it. ffmpeg writes a progress line several
  times a second, so on anything long the progress spam is what survives and
  the error that explains the failure is what gets evicted. Only one of the
  five passed it.
- **`-nostdin` is about the runtime, not the job.** In a guest there is no
  terminal, and an ffmpeg that decides to read stdin is a process that never
  exits. That is a fact about where this SDK runs, so it belongs here rather
  than in each caller's argv.

`-y` overwrites the output without asking, which is right for both shapes a
step uses — a temp file it just named, or `pipe:1`.

`loglevel` defaults to `"error"`. Pass `"info"` for a filter that reports
through the LOG rather than to a file — `loudnorm`'s `print_format=json` is
the case, and at `error` that pass runs, succeeds, and prints nothing.

**ffprobe takes none of this.** It rejects `-nostdin` and `-nostats`
outright, so [probeMedia](#probemedia) builds its own argv and this helper is for
ffmpeg only.

#### Parameters

##### options?

###### loglevel?

`string`

#### Returns

`string`[]

#### Example

```ts
import { ffmpegBaseArgs, runFfmpeg } from "@alexkroman1/aai/ffmpeg";

await runFfmpeg([...ffmpegBaseArgs(), "-i", "/tmp/in.m4a", "/tmp/out.wav"]);
await runFfmpeg([...ffmpegBaseArgs({ loglevel: "info" }), "-i", "/tmp/in.wav", "-f", "null", "-"]);
```

***

### isFfmpegError()

```ts
function isFfmpegError(value: unknown): value is FfmpegError;
```

Narrow an unknown catch to a failed ffmpeg run.

#### Parameters

##### value

`unknown`

#### Returns

`value is FfmpegError`

***

### probeMedia()

```ts
function probeMedia(source: FfmpegSource, opts?: ProbeOptions): Promise<MediaInfo>;
```

What ffprobe makes of a file: duration, container, and every stream.

```ts
import { probeMedia } from "@alexkroman1/aai/ffmpeg";

const info = await probeMedia("/tmp/recording.m4a");
const seconds = info.durationSec ?? 0;
const needsTranscode = info.audio?.codec !== "pcm_s16le";
```

A field ffprobe did not report comes back `undefined` rather than zero — see
`_ffmpeg-json.ts` for why that distinction is load-bearing. Reading a
duration off a PIPE is the one case worth knowing about: for a format whose
duration lives in a trailing index, ffprobe cannot seek to it and answers
`undefined`, where the same file on disk answers exactly.

#### Parameters

##### source

[`FfmpegSource`](#ffmpegsource)

##### opts?

[`ProbeOptions`](#probeoptions)

#### Returns

`Promise`\<[`MediaInfo`](#mediainfo)\>

***

### runFfmpeg()

```ts
function runFfmpeg(args: readonly string[], opts?: FfmpegRunOptions): Promise<FfmpegRunResult>;
```

Run ffmpeg with `args`, exactly as given.

Resolves only on a zero exit; every other outcome is a [FfmpegError](#ffmpegerror)
naming its [FfmpegFailureKind](#ffmpegfailurekind).

#### Parameters

##### args

readonly `string`[]

##### opts?

[`FfmpegRunOptions`](#ffmpegrunoptions)

#### Returns

`Promise`\<[`FfmpegRunResult`](#ffmpegrunresult)\>

#### Example

```ts
import { ffmpegBaseArgs, runFfmpeg } from "@alexkroman1/aai/ffmpeg";

// File to file: nothing is buffered, so this is the shape for long media.
await runFfmpeg([
  ...ffmpegBaseArgs(),
  "-i", "/tmp/in.m4a",
  "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
  "/tmp/out.wav",
]);
```

***

### transcodeToWav()

```ts
function transcodeToWav(source: FfmpegSource, opts?: TranscodeToWavOptions): Promise<Uint8Array<ArrayBufferLike>>;
```

Re-encode anything ffmpeg can read into linear-PCM WAV bytes.

The conversion a transcription pipeline needs, because cutting a recording by
byte offset is only arithmetic on uncompressed audio. Video is dropped.

The result is held in memory, so it is capped like any other piped output
(64 MiB) — about an hour of 16 kHz mono
at the default. Past that, go file → file with [wavEncodeArgs](#wavencodeargs).

Note WAV written to a PIPE carries a placeholder length in its header:
ffmpeg cannot seek back to patch it once the size is known. Every decoder
treats it as "read to EOF", and this repo's own `parseWav` intersects the
declared length with the real byte count for exactly that reason — but code
that trusts the header's `data` size will read zero samples.

#### Parameters

##### source

[`FfmpegSource`](#ffmpegsource)

##### opts?

[`TranscodeToWavOptions`](#transcodetowavoptions)

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### wavEncodeArgs()

```ts
function wavEncodeArgs(opts?: WavEncodeOptions): string[];
```

The encoder half of a linear-PCM WAV argv — no input, no output.

Exported because the in-memory [transcodeToWav](#transcodetowav) is the wrong shape for
a long recording, and a caller writing file → file should not have to
re-derive which of ffmpeg's codec names is uncompressed:

```ts no-check
import { runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";

await runFfmpeg([
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
  "-i", inputPath,
  ...wavEncodeArgs({ sampleRate: 16_000, channels: 1 }),
  outputPath,
]);
```

#### Parameters

##### opts?

[`WavEncodeOptions`](#wavencodeoptions)

#### Returns

`string`[]

## Classes

### FfmpegError

A failed ffmpeg run, with the diagnosis attached.

`stderr` is the tail of ffmpeg's own log, which is where the reason is
("Invalid data found when processing input", "Output file #0 does not contain
any stream"). [kind](#kind) is what a caller BRANCHES on — see the module doc's
point 3 for why a workflow step must, rather than retrying a corrupt file
until its attempts run out.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new FfmpegError(opts: {
  argv: readonly string[];
  binary: string;
  cause?: unknown;
  exitCode?: number | null;
  kind: FfmpegFailureKind;
  message: string;
  signal?: Signals | null;
  stderr?: string;
}): FfmpegError;
```

###### Parameters

###### opts

###### argv

readonly `string`[]

###### binary

`string`

###### cause?

`unknown`

###### exitCode?

`number` \| `null`

###### kind

[`FfmpegFailureKind`](#ffmpegfailurekind)

###### message

`string`

###### signal?

`Signals` \| `null`

###### stderr?

`string`

###### Returns

[`FfmpegError`](#ffmpegerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### argv

```ts
readonly argv: readonly string[];
```

##### binary

```ts
readonly binary: string;
```

The binary that was spawned, and the arguments it got.

##### exitCode

```ts
readonly exitCode: number | null;
```

Exit status, or `null` when the child was killed by a signal.

##### kind

```ts
readonly kind: FfmpegFailureKind;
```

##### signal

```ts
readonly signal: Signals | null;
```

The signal that killed it, when one did.

##### stderr

```ts
readonly stderr: string;
```

The tail of the child's stderr — ffmpeg's log.

## Type Aliases

### FfmpegFailureKind

```ts
type FfmpegFailureKind = "exit" | "timeout" | "aborted" | "missing-binary" | "output-too-large";
```

Which way a run failed — see [FfmpegError](#ffmpegerror).

***

### FfmpegRunOptions

```ts
type FfmpegRunOptions = {
  binary?: string;
  cwd?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  stdin?: Uint8Array;
  timeoutMs?: number;
};
```

#### Properties

##### binary?

```ts
optional binary?: string;
```

The binary to spawn. Defaults to `AAI_FFMPEG_PATH`, `FFMPEG_PATH`, then `ffmpeg`.

##### cwd?

```ts
optional cwd?: string;
```

Working directory for the child, so relative paths in `args` resolve.

##### maxOutputBytes?

```ts
optional maxOutputBytes?: number;
```

Cap on captured stdout. Defaults to 64 MiB (`DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`).

##### signal?

```ts
optional signal?: AbortSignal;
```

Kill the run when this aborts. Combined with `timeoutMs`, not replaced by it.

##### stdin?

```ts
optional stdin?: Uint8Array;
```

Bytes to write to the child's stdin — read them in the argv as `pipe:0`.

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

Wall-clock budget. Defaults to 10 minutes (`DEFAULT_FFMPEG_TIMEOUT_MS`).

***

### FfmpegRunResult

```ts
type FfmpegRunResult = {
  durationMs: number;
  stderr: string;
  stdout: Uint8Array;
};
```

#### Properties

##### durationMs

```ts
durationMs: number;
```

Wall-clock milliseconds the child ran for.

##### stderr

```ts
stderr: string;
```

The tail of ffmpeg's log, on SUCCESS too: it carries the encode summary.

##### stdout

```ts
stdout: Uint8Array;
```

Whatever the child wrote to stdout — empty for a run that wrote to a file.

***

### FfmpegSource

```ts
type FfmpegSource = string | Uint8Array;
```

A media input: a filesystem path, or the bytes themselves.

***

### MediaInfo

```ts
type MediaInfo = {
  audio?: MediaStreamInfo;
  bitRate?: number;
  durationSec?: number;
  format?: string;
  raw: unknown;
  sizeBytes?: number;
  streams: MediaStreamInfo[];
  video?: MediaStreamInfo;
};
```

What `parseProbeJson` makes of one media file — see `@alexkroman1/aai/ffmpeg`.

#### Properties

##### audio?

```ts
optional audio?: MediaStreamInfo;
```

The first audio stream — the one an audio pipeline almost always means.

##### bitRate?

```ts
optional bitRate?: number;
```

Overall bit rate in bits per second.

##### durationSec?

```ts
optional durationSec?: number;
```

Duration in seconds, or `undefined` when the container does not say.

##### format?

```ts
optional format?: string;
```

ffprobe's format name(s), e.g. `"wav"`, `"mov,mp4,m4a,3gp,3g2,mj2"`.

##### raw

```ts
raw: unknown;
```

ffprobe's parsed JSON, verbatim, for a field this type does not name.

##### sizeBytes?

```ts
optional sizeBytes?: number;
```

File size in bytes, as ffprobe measured it.

##### streams

```ts
streams: MediaStreamInfo[];
```

Every stream, in ffprobe's order.

##### video?

```ts
optional video?: MediaStreamInfo;
```

The first video stream.

***

### MediaStreamInfo

```ts
type MediaStreamInfo = {
  channels?: number;
  codec?: string;
  durationSec?: number;
  height?: number;
  index: number;
  kind: string;
  sampleFormat?: string;
  sampleRate?: number;
  width?: number;
};
```

One elementary stream inside a container.

#### Properties

##### channels?

```ts
optional channels?: number;
```

Channel count (audio).

##### codec?

```ts
optional codec?: string;
```

Decoder name, e.g. `"pcm_s16le"`, `"aac"`, `"h264"`.

##### durationSec?

```ts
optional durationSec?: number;
```

Stream duration in seconds, when the container declares a per-stream one.

##### height?

```ts
optional height?: number;
```

##### index

```ts
index: number;
```

ffprobe's own stream index — what `-map 0:<index>` names.

##### kind

```ts
kind: string;
```

`"audio"`, `"video"`, `"subtitle"`, `"data"`, …

##### sampleFormat?

```ts
optional sampleFormat?: string;
```

Sample format, e.g. `"s16"`, `"fltp"` (audio).

##### sampleRate?

```ts
optional sampleRate?: number;
```

Samples per second (audio).

##### width?

```ts
optional width?: number;
```

Pixel dimensions (video).

***

### ProbeOptions

```ts
type ProbeOptions = Omit<FfmpegRunOptions, "stdin" | "binary"> & {
  binary?: string;
};
```

#### Type Declaration

##### binary?

```ts
optional binary?: string;
```

The `ffprobe` binary. Defaults to `AAI_FFPROBE_PATH`, `FFPROBE_PATH`, then `ffprobe`.

***

### TranscodeToWavOptions

```ts
type TranscodeToWavOptions = WavEncodeOptions & Omit<FfmpegRunOptions, "stdin">;
```

***

### WavEncodeOptions

```ts
type WavEncodeOptions = {
  bitsPerSample?: 16 | 24 | 32;
  channels?: number;
  sampleRate?: number;
};
```

#### Properties

##### bitsPerSample?

```ts
optional bitsPerSample?: 16 | 24 | 32;
```

Sample width, 16 or 24 or 32 bits. Defaults to 16.

##### channels?

```ts
optional channels?: number;
```

Output channel count. Omit to keep the input's. 1 is what STT wants.

##### sampleRate?

```ts
optional sampleRate?: number;
```

Output sample rate. Omit to keep the input's.
