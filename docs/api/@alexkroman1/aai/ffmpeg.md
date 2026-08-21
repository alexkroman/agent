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

```ts no-check
import { readUpload } from "@alexkroman1/aai/utils";
import { probeMedia, transcodeToWav } from "@alexkroman1/aai/ffmpeg";

export async function toPcm(uploadId: string) {
  "use step";
  const { bytes } = await readUpload(uploadId);
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
   ([FFMPEG\_STDERR\_TAIL\_CHARS](#ffmpeg_stderr_tail_chars)) because ffmpeg's log is progress lines
   and the diagnosis is the last one; stdout is capped
   ([DEFAULT\_MAX\_FFMPEG\_OUTPUT\_BYTES](#default_max_ffmpeg_output_bytes)) and exceeding it kills the child
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

Both take a [MediaSource](#mediasource): a path string, or bytes piped in on `pipe:0`.
Bytes are what a step HAS (`readUpload` answers with them), so they are the
default shape here — but piping is not free of caveats, and they are the
caller's to know: a format whose index lives at the END of the file (a
non-faststart MP4) cannot be read from a pipe, and ffmpeg says so. Write those
to a temp file and pass the path. Large media should go file → file anyway:
nothing is buffered then, and `output` in an argv you build yourself is the
whole difference.

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

##### cause?

```ts
optional cause?: unknown;
```

###### Inherited from

```ts
Error.cause
```

##### exitCode

```ts
readonly exitCode: number | null;
```

Exit status, or `null` when the child was killed by a signal.

##### kind

```ts
readonly kind: FfmpegFailureKind;
```

##### message

```ts
message: string;
```

###### Inherited from

```ts
Error.message
```

##### name

```ts
name: string;
```

###### Inherited from

```ts
Error.name
```

##### signal

```ts
readonly signal: Signals | null;
```

The signal that killed it, when one did.

##### stack?

```ts
optional stack?: string;
```

###### Inherited from

```ts
Error.stack
```

##### stderr

```ts
readonly stderr: string;
```

The tail of the child's stderr — ffmpeg's log.

##### stackTraceLimit

```ts
static stackTraceLimit: number;
```

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

###### Inherited from

```ts
Error.stackTraceLimit
```

#### Methods

##### captureStackTrace()

```ts
static captureStackTrace(targetObject: object, constructorOpt?: Function): void;
```

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

###### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

###### Returns

`void`

###### Inherited from

```ts
Error.captureStackTrace
```

##### isError()

```ts
static isError(error: unknown): error is Error;
```

Indicates whether the argument provided is a built-in Error instance or not.

###### Parameters

###### error

`unknown`

###### Returns

`error is Error`

###### Inherited from

```ts
Error.isError
```

##### prepareStackTrace()

```ts
static prepareStackTrace(err: Error, stackTraces: CallSite[]): any;
```

###### Parameters

###### err

`Error`

###### stackTraces

`CallSite`[]

###### Returns

`any`

###### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

###### Inherited from

```ts
Error.prepareStackTrace
```

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

Cap on captured stdout. Defaults to [DEFAULT\_MAX\_FFMPEG\_OUTPUT\_BYTES](#default_max_ffmpeg_output_bytes).

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

Wall-clock budget. Defaults to [DEFAULT\_FFMPEG\_TIMEOUT\_MS](#default_ffmpeg_timeout_ms).

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

### MediaInfo

```ts
type MediaInfo = {
  audio?: MediaStream;
  bitRate?: number;
  durationSec?: number;
  format?: string;
  raw: unknown;
  sizeBytes?: number;
  streams: MediaStream[];
  video?: MediaStream;
};
```

What `parseProbeJson` makes of one media file — see `@alexkroman1/aai/ffmpeg`.

#### Properties

##### audio?

```ts
optional audio?: MediaStream;
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
streams: MediaStream[];
```

Every stream, in ffprobe's order.

##### video?

```ts
optional video?: MediaStream;
```

The first video stream.

***

### MediaSource

```ts
type MediaSource = string | Uint8Array;
```

A media input: a filesystem path, or the bytes themselves.

***

### MediaStream

```ts
type MediaStream = {
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

## Variables

### DEFAULT\_FFMPEG\_TIMEOUT\_MS

```ts
const DEFAULT_FFMPEG_TIMEOUT_MS: number;
```

How long one ffmpeg run may take before it is killed.

Ten minutes, which is long: transcoding an hour of audio is minutes of real
work, and a step that has already read its input off object storage should
not lose it to a budget tighter than the job. It is a BACKSTOP against a run
that will never finish, not a service-level target — a caller with a tighter
one passes `timeoutMs`, and a workflow step has its own budget above this.

***

### DEFAULT\_MAX\_FFMPEG\_OUTPUT\_BYTES

```ts
const DEFAULT_MAX_FFMPEG_OUTPUT_BYTES: number;
```

How many bytes a run may write to stdout before it is killed.

64 MiB. Only piped output counts against it (`pipe:1`), and it exists because
the alternative is an OOM: a guest reserves ~1 GiB, and captured output is
held whole in the guest's heap on its way to being returned. Raise it
deliberately for a big in-memory conversion, or write to a file and capture
nothing.

***

### FFMPEG\_PATH\_ENV

```ts
const FFMPEG_PATH_ENV: "AAI_FFMPEG_PATH" = "AAI_FFMPEG_PATH";
```

Overrides the `ffmpeg` binary this module spawns.

***

### FFMPEG\_STDERR\_TAIL\_CHARS

```ts
const FFMPEG_STDERR_TAIL_CHARS: 4000 = 4000;
```

How much of ffmpeg's log is kept, from the END.

ffmpeg writes progress to stderr — one line per statistics interval for the
whole run — and the reason it failed is the last thing in there. So a tail is
not a compromise here, it is the informative part; a head would be the
banner and the input's stream list every time.

CHARACTERS, not bytes, and the name says so because the two differ exactly
where it matters: a log naming `Café.m4a` is UTF-8, and a byte-sliced tail
can cut a character in half. The stream is decoded with a `StringDecoder`
for the same reason — a chunk boundary lands mid-character often enough that
`chunk.toString()` per chunk produces a replacement character in the one
message a human reads.

***

### FFPROBE\_PATH\_ENV

```ts
const FFPROBE_PATH_ENV: "AAI_FFPROBE_PATH" = "AAI_FFPROBE_PATH";
```

Overrides the `ffprobe` binary this module spawns.

## Functions

### ffmpegVersion()

```ts
function ffmpegVersion(opts?: FfmpegRunOptions): Promise<string | undefined>;
```

ffmpeg's version string, or `undefined` when there is no ffmpeg to ask.

A preflight check for a step or a diagnostic that would rather report "no
ffmpeg here" than fail mid-conversion. Only a MISSING binary answers
`undefined`; a binary that is present and broken throws, because that is a
real failure and swallowing it would report the same thing as an absence.

#### Parameters

##### opts?

[`FfmpegRunOptions`](#ffmpegrunoptions)

#### Returns

`Promise`\<`string` \| `undefined`\>

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
function probeMedia(source: MediaSource, opts?: ProbeOptions): Promise<MediaInfo>;
```

What ffprobe makes of a file: duration, container, and every stream.

```ts no-check
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

[`MediaSource`](#mediasource)

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

```ts no-check
import { runFfmpeg } from "@alexkroman1/aai/ffmpeg";

// File to file: nothing is buffered, so this is the shape for long media.
await runFfmpeg([
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
  "-i", "/tmp/in.m4a",
  "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
  "/tmp/out.wav",
]);
```

***

### transcodeToWav()

```ts
function transcodeToWav(source: MediaSource, opts?: TranscodeToWavOptions): Promise<Uint8Array<ArrayBufferLike>>;
```

Re-encode anything ffmpeg can read into linear-PCM WAV bytes.

The conversion a transcription pipeline needs, because cutting a recording by
byte offset is only arithmetic on uncompressed audio. Video is dropped.

The result is held in memory, so it is capped like any other piped output
(see [DEFAULT\_MAX\_FFMPEG\_OUTPUT\_BYTES](#default_max_ffmpeg_output_bytes)) — about an hour of 16 kHz mono
at the default. Past that, go file → file with [wavEncodeArgs](#wavencodeargs).

Note WAV written to a PIPE carries a placeholder length in its header:
ffmpeg cannot seek back to patch it once the size is known. Every decoder
treats it as "read to EOF", and this repo's own `parseWav` intersects the
declared length with the real byte count for exactly that reason — but code
that trusts the header's `data` size will read zero samples.

#### Parameters

##### source

[`MediaSource`](#mediasource)

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
