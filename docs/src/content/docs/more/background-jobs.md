---
title: Background jobs
description: Work that outlives a turn — a file to transcribe, an archive to summarize.
---

Some work takes minutes. Transcribing an hour of audio, say. That is too long to
keep a caller on the line, so it goes in `workflows/` instead.

A workflow run survives the process it started in. Restart a sixty-segment job
at segment 41 and the first forty are not re-done.

## The shape

A workflow body is an ordinary exported async function of its input and a
`WorkflowContext`. There is no directive and no build step of its own:

```ts
// workflows/transcribe.ts
import type { WorkflowContext } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";

type Segment = { index: number };

export async function transcribeFlow(
  input: { recording: string },
  ctx: WorkflowContext,
) {
  const { recording } = input;
  const segments = await ctx.step("plan", () => planSegments(recording));

  // Four at a time, each its own step: a dropped connection costs one
  // segment, not the run. One NAME for all of them — see "Naming your
  // steps" below.
  const parts = await mapConcurrent(segments, 4, (seg) =>
    ctx.step("transcribeSegment", () => transcribeSegment(seg)),
  );

  return { text: parts.map((part) => part.text).join(" ") };
}

async function planSegments(recording: string): Promise<Segment[]> {
  // The whole Node runtime is available in a step: fetch, a model call, a
  // database. Not in the body.
  return [{ index: 0 }, { index: 1 }];
}

async function transcribeSegment(segment: Segment): Promise<{ text: string }> {
  return { text: `part ${segment.index}` };
}
```

`ctx.step(name, fn)` runs `fn` once and records what it returned.

The body is re-run from the top on every resume. Each step that already finished
returns its recorded value instead of running again. That replay is what makes a
run survive a restart.

## Naming your steps

A step is recorded under its name plus the number of times this run has already
reached that name: `transcribeSegment#0`, `transcribeSegment#1`, and so on,
counted per name. Two rules follow from that.

### Use ONE name for a loop or a fan-out

A fan-out of any size stays one literal: sixty segments would be sixty distinct
records under `transcribeSegment`. That is exactly what the occurrence counter
is for.

So do not build a name per item. `` ctx.step(`segment-${seg.index}`, …) ``
looks like the careful version and is the bug.

:::caution[An interpolated step name breaks the replay]
An interpolated name is computed at run time, so a replay mints a key no earlier
attempt reached — and the step either runs a second time or the run is refused.
Measured on a one-line body: 7 of 10 runs ran the side effect twice, all 10
reporting `completed`. `aai build` and `aai publish` scan for this and warn.
:::

**Your fan-out callback must call `ctx.step` as its first act.**

```ts
import type { WorkflowContext } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";

declare const ctx: WorkflowContext;
declare const segments: { index: number }[];
declare function fetchAudio(segment: { index: number }): Promise<string>;
declare function transcribe(audio: string): Promise<{ text: string }>;

// ✅ The step is issued straight away, so the order is the list's.
await mapConcurrent(segments, 4, (seg) =>
  ctx.step("transcribeSegment", async () => transcribe(await fetchAudio(seg))),
);

// ❌ The await comes first, so the order is whichever fetch happened to land.
await mapConcurrent(segments, 4, async (seg) => {
  const audio = await fetchAudio(seg);
  return ctx.step("transcribeSegment", () => transcribe(audio));
});
```

Journal keys are handed out in the order steps are **issued**. Issue
immediately and that order is the list's — the same on every replay, whichever
slot `mapConcurrent` happened to run the item in. Await first and it becomes
the order things finished in, which is a different order each run.

### Use a DIFFERENT name for each call site

Two call sites that share a literal share the counter, so whichever one is
reached second reads the first one's recorded result. Nothing checks this today,
so keep it as a convention: one name per call site, one call site per name.

## Sleeping, and waiting

`ctx.sleep("settle", 6 * 60 * 60 * 1000)` suspends rather than blocks. The
container is free to exit, and the run resumes when the sleep comes due. Six
hours costs the same as ten seconds.

A sleep's label, and `ctx.waitFor(token)`'s token, are journal keys on the same
(name, occurrence) scheme — so both naming rules above apply to them too.

## What a body may not do

The replay is also what constrains the body itself:

- **No `Date.now()`, no `Math.random()`, no `fetch`.** Those belong in a step.
  `ctx.now()`, `ctx.random()` and `ctx.uuid()` are the journaled readings for a
  body that needs one anyway.
- **Keep a step's arguments and return value JSON-shaped and small.** Both are
  recorded. Put bytes in an upload and pass the id.

## Starting one from a call

A tool starts a run and answers the turn immediately. That is what you want
whenever the honest answer is "that'll take a few minutes":

```ts no-check
// tools/start_transcription.ts
import { tool } from "@alexkroman1/aai";
import { transcribe } from "../agent.ts";

export default tool({
  description: "Start transcribing the caller's recording",
  execute: async (_args, ctx) => {
    const input = { recording: "…" };
    // `notify` makes this session take an unprompted, interruptible turn
    // when the run lands — so the agent keeps the "I'll let you know".
    await ctx.workflows.start(transcribe, input, { notify: true });
    return { started: true };
  },
});
```

## When there is no call at all

Sometimes the audio arrives as a file and there is no microphone in the story.

Declare a `workflowApp()` instead of an `agent()`. You get an ordinary web page
over the same runtime — no session, no live audio, no model loop:

```ts no-check
// agent.ts
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { transcribeFlow } from "./workflows/transcribe.ts";

export const transcribe = workflow({
  description: "Transcribe a recording",
  input: z.object({
    recording: z.string().describe("A linear-PCM WAV recording"),
  }),
  uploads: ["recording"],
  run: transcribeFlow,
});

export default workflowApp({
  name: "Transcription Desk",
  workflows: { transcribe },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
```

A body lives in `workflows/`, but unlike a tool it is not picked up by being
there. The `workflows` map above registers it, under the name you give it.

`aai dev`, `aai build`, and `aai publish` treat this like any other agent. The
voice fields — `systemPrompt`, the provider stages, the voice options — are not
available here, so setting one is a type error rather than a setting that
silently does nothing.

Its page is a `client.tsx` calling `mountPage()` rather than `mountClient()`.
Retries, webhooks, signals, `wake`, and the full step vocabulary are in the
[SDK reference](/agent/reference/).

## Next

- [Your own UI](/agent/more/custom-ui/) — the browser side
- [Publish](/agent/deploy/publish/) — shipping it
