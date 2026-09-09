---
title: Background jobs
description: Work that outlives a turn — a file to transcribe, an archive to summarize.
---

Some work takes minutes — transcribing an hour of audio, say. That is too long
to keep a caller on the line, so it goes in `workflows/` instead.

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

  // Four at a time, each its own step: a dropped
  // connection costs one segment, not the run. One NAME for all of them —
  // see "A step's name is not unique" below.
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

`ctx.step(name, fn)` runs `fn` once and records what it returned. The body is
re-run from the top on every resume, and each step that already finished
returns its recorded value instead of running again.

That is what makes the run survive the process it started in: restart a
sixty-segment job at segment 41 and the first forty are not re-done.

## A step's name is not unique — its identity is (name, occurrence)

A step's identity in that record is its name plus the number of times the run
has already reached that name: `transcribeSegment#0`, `transcribeSegment#1`,
and so on, counted per name. Two things follow, and the first reads backwards
until you know that:

- **A loop or a fan-out wants ONE name.** The sixty calls above are sixty
  distinct rows under one literal, which is exactly what the occurrence counter
  is for. So do not build a name per item: `` ctx.step(`segment-${seg.index}`,
  …) `` looks like the careful version and is the bug. An interpolated name is
  computed at run time, so a replay mints a key no earlier attempt reached, and
  the step either runs a second time or the run is refused. Measured on a
  one-line body: 7 of 10 runs ran the side effect twice, all 10 reporting
  `completed`. `aai build` and `aai publish` scan for this and warn.
- **Two DIFFERENT call sites want two names.** Sharing a literal means sharing
  the counter, so whichever site is reached second reads the first one's
  recorded result. Nothing checks that today, so it is a convention to keep:
  one name per call site, one call site per name.

Fan-out is safe under one name because the order the calls are ISSUED in is a
pure function of the list — `mapConcurrent` hands out the next item to whichever
slot is free, and nothing in a journal key depends on which slot that was. What
it asks of your callback is that it issue its step immediately: awaiting
something first, or issuing two steps in a row, is what makes issue order depend
on completion order.

`ctx.sleep("settle", 6 * 60 * 60 * 1000)` suspends rather than blocks — the
container is free to exit, and the run resumes when it comes due. Six hours
costs the same as ten seconds. Its label, and `ctx.waitFor(token)`'s token, are
journal keys on the same (name, occurrence) scheme, so everything above applies
to them.

The constraints follow from the replay: no `Date.now()`, no `Math.random()`,
no `fetch` in the body — those belong in a step, and `ctx.now()`,
`ctx.random()` and `ctx.uuid()` are the journaled readings for a body that
needs one anyway. A step's arguments and return value are recorded, so keep
them JSON-shaped and small. Put bytes in an upload and pass the id.

## Starting one from a call

A tool starts a run and answers the turn immediately, which is what you want
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
Declare a `workflowApp()` instead of an `agent()` and you get an ordinary web
page over the same runtime — no session, no live audio, no model loop:

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
there — the `workflows` map above is what registers it, under the name you
give it.

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
