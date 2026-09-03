# step-files

Moving bytes between the upload store and a local FILE — the plumbing an
ffmpeg step spends most of its lines on.

`@alexkroman1/aai/ffmpeg` takes bytes as happily as a path, and for a short
clip bytes are the better call. Everything larger goes file → file, for two
reasons that are properties of real recordings rather than preferences:

- **A pipe cannot seek.** An `.m4a` off a phone usually carries its `moov`
  index at the END of the file, so ffmpeg reading it from `pipe:0` fails with
  `moov atom not found`. That is the flagship input of every media pipeline
  anyone actually builds.
- **Piped output is capped**, at `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES` (64 MiB),
  which is about half an hour of 16 kHz mono PCM. The pipelines that need
  ffmpeg at all exist for the two-hour call.

So a step materializes the upload to a temp file, runs ffmpeg file → file,
and streams the result back into the store. Three functions, in that order:

```ts
import { join } from "node:path";
import { runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
import { readUploadToFile, withTempDir, writeUploadFromFile } from "@alexkroman1/aai/step-files";

export async function toWav(uploadId: string): Promise<string> {
  return await withTempDir(async (dir) => {
    const source = join(dir, "source");
    const converted = join(dir, "converted.wav");
    await readUploadToFile(uploadId, source);
    await runFfmpeg(["-nostdin", "-y", "-i", source, ...wavEncodeArgs({ channels: 1 }), converted]);
    const stored = await writeUploadFromFile(converted, { name: "audio.wav", type: "audio/wav" });
    return stored.id;
  });
}
```

Nothing here holds a whole recording in memory at any point, which is the
property that makes a step written on it work on the input it was written for.

## Why this is a subpath of its own, and not three more names on `/step`

Same rule as `@alexkroman1/aai/ffmpeg`: this module imports
`node:fs/promises`, `node:os` and `node:path`, and `@alexkroman1/aai/step` is
an `sdk/` barrel, which is the half of this package that must stay runnable in
a browser and in Deno. `sdk/tsconfig.json` compiles with `types: []` so the
boundary is a compile error rather than a convention, and
`step-files.import-graph.test.ts` holds the `/step` barrel's whole transitive
graph free of `node:` — a `node:` import three modules below a name somebody
added to that barrel is how this regresses.

These three names live in `host/` for the same reason and are reached by their
own subpath, so a `client.tsx` cannot pull them in by importing the step
vocabulary.

## A temp file may not outlive its step

A step is journaled by its RETURN VALUE and may be dispatched into a different
process than its neighbours, so a path in a return value is a path that is
replayed after the file behind it is gone — and the failure mode is a resumed
run reading a directory another run is using. [withTempDir](#withtempdir) makes the
lifetime a lexical scope: the directory is created on entry, removed on exit,
and what crosses the step boundary is an upload id.

## Functions

### readUploadToFile()

```ts
function readUploadToFile(
   uploadId: string, 
   path: string, 
   opts?: ReadUploadToFileOptions
): Promise<number>;
```

Write an upload to a local path, a window at a time, and answer with the byte
count that landed.

A `for` loop rather than a fan-out deliberately: the bytes land in one file at
one offset each, so concurrency buys nothing and costs exactly the memory the
windows are here to bound.

**The walk advances by what was READ, not by the window it asked for.** A
`readUpload` window is clamped to the bytes that have arrived, so on a STREAMED
upload — or on any stale `size` — a fixed `at += windowBytes` stride writes a
short chunk and then resumes a whole window later, silently leaving a hole in
the middle of the file. Advancing by `slice.end` cannot: a short answer ends
the walk, and the returned count is how the caller learns it was short.

**With no `size`, an upload that is still arriving is REFUSED.** That count was
documented as how a caller learns the store came back short, and against a
defaulted size it could never say so: the default was `uploadInfo(id).size`,
the contiguous readable PREFIX, so the walk copied the prefix and returned a
number equal to it. What reached ffmpeg was a truncated recording with nothing
anywhere reporting it. See `sdk/step-uploads-complete.ts`.

#### Parameters

##### uploadId

`string`

The id a run input carried.

##### path

`string`

Where to write. Created, or truncated if it exists.

##### opts?

[`ReadUploadToFileOptions`](#readuploadtofileoptions)

See [ReadUploadToFileOptions](#readuploadtofileoptions).

#### Returns

`Promise`\<`number`\>

Bytes written — equal to the upload's size unless the store came back
  short, which is the case a caller polling a streamed upload has to notice.

#### Throws

when no `size` was given and the upload is
  still arriving.

***

### withTempDir()

```ts
function withTempDir<T>(work: (dir: string) => Promise<T>, opts?: WithTempDirOptions): Promise<T>;
```

Run `work` with a private temp directory, and remove it afterwards.

`join(tmpdir(), …)` rather than a `/tmp` literal, which is this repo's rule
(`guard-invariants` rule 11) and not merely portability theatre: on Windows a
literal `/tmp/x` is DRIVE-RELATIVE, so it resolves somewhere that does not
exist and every write fails with ENOENT. A step runs in a Linux guest when it
is deployed and on the developer's own machine under `aai dev`, which is the
half that makes it matter.

The removal is in a `finally`, so it also runs on the failure paths — a guest's
disk is small, and a step that leaves a copy of every recording it touched
fills it. `force`, so a run that never created its output does not fail HERE
and replace the real error with this one.

#### Type Parameters

##### T

`T`

#### Parameters

##### work

(`dir`: `string`) => `Promise`\<`T`\>

Called with the directory. Its result is this call's result, so
  a step returns an upload id out of the scope rather than a path into it.

##### opts?

[`WithTempDirOptions`](#withtempdiroptions)

See [WithTempDirOptions](#withtempdiroptions).

#### Returns

`Promise`\<`T`\>

***

### writeUploadFromFile()

```ts
function writeUploadFromFile(path: string, opts?: WriteUploadFromFileOptions): Promise<UploadInfo>;
```

Store a local file as an upload, streaming it, and answer with the record.

The composition rather than the generator, and that is the whole design of this
function: `writeUpload(fileChunks(path), { … })` is three lines a caller can
write, and one of the three is a trap that has to be re-explained every time it
is written (see below). Handing over the composition means the trap is tested
once, here, by `step-files.test.ts` — where deleting the `.slice()` fails a
spec — rather than being a warning comment in every template that copies it.

A stream rather than `readFile` for the reason the windows above exist: the
converted audio is usually the largest thing a media step touches, and handing
the store an `AsyncIterable` is what keeps it off the heap.

#### Parameters

##### path

`string`

The file to store. Read to EOF; never modified or removed, so a
  [withTempDir](#withtempdir) scope is still what owns its lifetime.

##### opts?

[`WriteUploadFromFileOptions`](#writeuploadfromfileoptions)

`name` and `type` are stored verbatim and neither is inferred —
  pass both, since `type` is what the byte route serves as `Content-Type` and a
  browser will not play a file it was handed as bytes. See
  [WriteUploadFromFileOptions](#writeuploadfromfileoptions).

#### Returns

`Promise`\<[`UploadInfo`](step.md#uploadinfo)\>

## Type Aliases

### ReadUploadToFileOptions

```ts
type ReadUploadToFileOptions = {
  size?: number;
  windowBytes?: number;
};
```

Options for [readUploadToFile](#readuploadtofile).

#### Properties

##### size?

```ts
optional size?: number;
```

How many bytes the upload holds. Defaults to what `requireCompleteUpload`
reports — so with no size, an upload that is still ARRIVING is refused.

Pass it only when you already have the record — a step that reported the
file's name and size before starting has one, and this saves a second look.
Passing a size LARGER than the store holds is not an error: `readUpload`
clamps its window to what has arrived, and this walk stops at what it was
actually given rather than at what it asked for.

**Passing one moves the completeness judgement to the CALLER**, which is
what makes a polling body expressible: this option means "I have read the
record", and a caller who has read it can see `complete` for itself. It
therefore has to read it — `uploadInfo(id).size` threaded in here is the
whole bug this default now refuses, since that number IS the prefix.

##### windowBytes?

```ts
optional windowBytes?: number;
```

Bytes per read. Defaults to [STEP\_FILE\_WINDOW\_BYTES](#step_file_window_bytes).

***

### WithTempDirOptions

```ts
type WithTempDirOptions = {
  prefix?: string;
};
```

Options for [withTempDir](#withtempdir).

#### Properties

##### prefix?

```ts
optional prefix?: string;
```

Prefix for the directory's name, under the OS temp directory.

Defaults to `"aai-step-"`. Worth setting to something naming the pipeline
(`"aai-normalize-"`): the directory is gone by the time anyone looks, so the
prefix's real audience is a person reading `ls /tmp` during a run that hung,
and a spec asserting that nothing was left behind.

***

### WriteUploadFromFileOptions

```ts
type WriteUploadFromFileOptions = WriteUploadOptions & {
  windowBytes?: number;
};
```

Options for [writeUploadFromFile](#writeuploadfromfile) — [WriteUploadOptions](step.md#writeuploadoptions), plus the window.

#### Type Declaration

##### windowBytes?

```ts
optional windowBytes?: number;
```

Bytes per read. Defaults to [STEP\_FILE\_WINDOW\_BYTES](#step_file_window_bytes).

## Variables

### STEP\_FILE\_WINDOW\_BYTES

```ts
const STEP_FILE_WINDOW_BYTES: 8388608 = 8388608;
```

Bytes moved per store round trip, in either direction.

8 MiB is large enough that a two-hour recording is a few hundred round trips
rather than tens of thousands, and small enough that a step's resident set is a
constant rather than a function of the recording. The number this must NOT be
is "the whole file", which is the shape every first draft has — and the reason
the window is nameable at all is that both functions below take it as an
option, which is what makes their multi-window paths reachable from a spec
without writing 16 MB to a disk.
