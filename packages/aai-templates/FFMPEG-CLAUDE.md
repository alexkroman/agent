---
summary: >-
  `call-audit-workflow` as the reference use of `@alexkroman1/aai/ffmpeg`, and
  what cutting a recording at human boundaries takes
read_when: >-
  working on `call-audit-workflow` or anything that uses `/ffmpeg`
---

# packages/aai-templates — ffmpeg in the templates

A SIBLING of `packages/aai-templates/CLAUDE.md`, read on demand: this section is
REFERENCE for someone already working in this area.

## ffmpeg is what lets a desk cut a recording where a HUMAN would

`call-audit-workflow` is the reference use of `@alexkroman1/aai/ffmpeg`, and
until it existed that subpath's only worked example was a `no-check` snippet in
`packages/aai-guest/CLAUDE.md`. It is the deepest of the workflow apps and the
wrong one to read first — `link-digest-workflow` owns the shape,
`transcription-workflow` the fan-out, `spoken-summary-workflow` the audio round
trip — so what it is FOR is the one thing none of those can show: what changes
downstream when a decoder is in the pipeline.

The answer is that almost everything gets SMALLER, which is the argument worth
keeping. `transcription-workflow` cuts by arithmetic because with no decoder
that is all it can do, and it pays for that three times over. Normalizing first,
to a format the desk itself chose, deletes all three:

|                      | `transcription-workflow`                 | `call-audit-workflow`        |
| -------------------- | ---------------------------------------- | ---------------------------- |
| intermediate         | linear-PCM WAV                           | headerless raw PCM           |
| header               | parsed — `parseWav`, ~180 lines          | **none: byte 0 is second 0** |
| cut at               | every 90s, wherever that lands           | **the middle of a pause**    |
| overlap              | 2s per segment, transcribed twice        | **none**                     |
| stitching            | seam matching over 40 words              | **ordered concatenation**    |
| caps to plan against | 120s AND 40 MB, whichever binds          | **120s**                     |
| fan-out width        | derived per recording from a byte budget | **a constant**               |

Four rules came out of building it, each of which a first draft gets wrong:

- **An analysis whose output grows with the recording must NOT come back on
  stderr.** The SDK keeps a capped stderr TAIL (`FFMPEG_STDERR_TAIL_CHARS`, 4000
  chars), which is right for `loudnorm`'s one fixed-size JSON block printed
  after the last frame, and wrong for `silencedetect`, which logs an event per
  pause — 720 of them on a two-hour call. What a tail drops is the BEGINNING, so
  the failure is a desk that cuts the back half of every long recording and the
  front half of none, silently, on inputs nobody tests with.
  `ametadata=mode=print:file=…` writes to a path with no cap, and does so at
  `-loglevel error`, so that pass is quiet AND complete. The mirror-image trap
  is on the other pass: `print_format=json` writes through the LOG, so at
  `-loglevel error` the measure pass runs, succeeds, and prints nothing.
- **Build the argv in a pure module, and it becomes testable.** An ffmpeg step
  is untestable exactly where it spawns, so `workflows/media.ts` holds every
  argv and both parsers as pure functions, and the materialize → spawn → store
  shell is the SDK's `transcodeUpload(uploadId, { args, output, probe })`
  (`@alexkroman1/aai/step-files`), which also prepends the standing flags
  (`-nostdin` among them — the one whose absence hangs a guest). That is what
  makes 100% line coverage of the decisions possible in the UNIT tier, with no
  subprocess. The spawn itself is reachable from that tier too:
  `installStubFfmpeg` (`@alexkroman1/aai-runtime/testing/vitest`) swaps the
  child the SDK's runners spawn for a scripted one, so `ingestRecording` runs
  end to end in `agent.test.ts` with the probe answering JSON, the measure pass
  printing the captured `loudnorm` block, and the normalize pass writing the PCM
  and the silence log itself. A fake script on `AAI_FFMPEG_PATH` is NOT the
  alternative: that is a subprocess, which puts the spec in the scenario tier.
- **A temp file may not cross a step boundary**, so the shape of an ffmpeg step
  is decided by materialization cost rather than by retry granularity.
  `ingestRecording` runs `ffprobe` and both `loudnorm` passes in ONE step
  because splitting them would read the whole recording out of the upload store
  three times — and on a 700 MB file that is the expensive part by an order of
  magnitude, while the decodes are seconds. Its module doc carries the argument.
- **Plan byte offsets from the BYTE COUNT, never from a duration.**
  `pcmDurationMs` answers whole milliseconds, so a 640,500-byte file reports
  20,016 ms where it holds 20,015.625 — and planning from that put the last
  segment's `endByte` twelve bytes past the end of the file. `stepReadUpload`
  clamps a window to the stored size, so nothing threw; the plan simply
  described audio that did not exist. `planSegments` therefore takes the byte
  count and derives its own seconds. **It was found by running the real argv
  against a real ffmpeg**, which is the only place a twelve-byte error was ever
  going to surface, and it is the reason the spec's fixtures are captured from
  ffmpeg 6.1.1 verbatim rather than typed from the documentation.

**The desk stays honest about the case it cannot serve.** A stretch of unbroken
speech longer than the cap has no pause to cut in, so it gets the blind cut —
flagged as `cutInSpeech`, counted in the run's output, and rendered on the page.
A mangled word at a seam is otherwise a mystery, and hiding the one number that
explains it would be the worse trade.

The same subpath also closed a defect in `transcription-workflow`, which is
worth reading as the SMALL version of all of this: `workflows/normalize.ts`
converts anything that is not already cuttable, so its classic flow accepts an
m4a off a phone. **The test for whether to convert is `parseWav` ITSELF**, not
an `ffprobe` codec check — a `WAVE_FORMAT_EXTENSIBLE` file reports `pcm_s16le`
to ffprobe and is refused by the parser, so a probe-based check would pass it
through and then fail to cut it. Asking the downstream authority as a QUESTION
makes the two decisions the same decision by construction, and it repairs
anything the parser rejects for any reason — a 192 kHz 32-bit WAV over
`MAX_BYTES_PER_SECOND` included. `transcribeStream` still refuses, and has to:
it cuts while the bytes are still arriving, and a partial file is not something
a decoder can be pointed at.

Both probing steps report what the file WAS before they touch it — "Levelling
41:20 of aac to 16 kHz mono" — and both had written the phrase themselves, one
answering `unknown` where the other answered `the recording` for a codec ffprobe
did not name. `describeMedia` (`@alexkroman1/aai/ffmpeg`) is that phrase now,
degrading a field at a time; the two lines are one `stepReport` each.

### A `workflows/` module may hold a Node-only import at module scope

`call-audit-workflow/workflows/ingest.ts` holds `node:fs/promises`,
`@alexkroman1/aai/ffmpeg` and `@alexkroman1/aai/step-files` at module scope:
workflows compile into the one worker artifact, so there is no separate VM
bundle a Node-reaching import could break at replay.

**What generalizes is the failure SHAPE.** It did not reproduce in-tree — pnpm
links the workspace SDK and `@dev/source` resolves it to TypeScript — so every
gate short of a real build was green while every deployed run failed. When a
rule depends on how a project's dependencies were INSTALLED, the in-tree run is
not evidence.

### A body names `WorkflowInputOf<typeof theInputSchema>`, never the def

A workflow body should take the schema's own output type — `WorkflowBody` is
contravariant, so a body restating a WIDER shape is assignable and nothing
warns, which is how `podcast-digest-workflow` came to re-implement six schema
`.default()`s with `??`. But **`WorkflowInputOf<typeof theDef>` does not
compile**: `workflow()` infers the output from `run`, so `typeof theDef` needs
the body's signature and vice versa — `TS7022` against `agent.ts`, plus
`TS2456`/`TS2502` at the body — and annotating the def (`WorkflowDef<…>`) only
buys it back by NAMING the output type by hand.

`WorkflowInputOf` accepts the schema directly, so name the schema const and
point the body at THAT:

```ts
// agent.ts
export const auditInput = z.object({ /* … */ });
export const audit = workflow({ input: auditInput, run: auditFlow });

// workflows/audit.ts
import type { auditInput } from "../agent.ts"; // erased at build: no runtime cycle
export async function auditFlow(input: WorkflowInputOf<typeof auditInput>, ctx: WorkflowContext) { … }
```

The def stays unannotated, so `WorkflowOutputOf<typeof audit>` is still the
body's inferred return — nothing is restated on either side. Every workflow-app
template is in this form.
