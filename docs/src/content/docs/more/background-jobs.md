---
title: Background jobs
description: Work that outlives a turn — a file to transcribe, an archive to summarize.
---

Some work takes minutes. Transcribing an hour of audio is too long for one
provider request, and far too long to hold a caller on the line. That work goes
in `workflows/`, where the build turns each function into journaled steps.

## The shape

```ts
// workflows/transcribe.ts
import { mapConcurrent, stepReport } from "@alexkroman1/aai/step";

type Segment = { index: number };

export async function transcribeFlow(input: { recording: string }) {
  "use workflow";

  const segments = await planSegments(input.recording);
  // Four at a time, each its own step: a dropped connection costs one segment.
  const parts = await mapConcurrent(segments, 4, (s) => transcribeSegment(s));
  return { text: parts.map((p) => p.text).join(" ") };
}

async function planSegments(recording: string): Promise<Segment[]> {
  "use step";
  await stepReport(`Planning ${recording}.`);
  return [{ index: 0 }];
}

async function transcribeSegment(segment: Segment): Promise<{ text: string }> {
  "use step";
  await stepReport(`Transcribing segment ${segment.index + 1}.`);
  return { text: "…" };
}
```

Two directives do the work. `"use workflow"` marks a body that **replays from
the top** on every resume; `"use step"` marks a function whose result is
journaled, so a completed step returns its recorded value instead of running
again.

What that buys: a sixty-segment run survives the process it started in. Resume
it at segment 41 and the first forty are not re-billed. `sleep("6 hours")`
suspends rather than blocks, so the container is free to exit. A step that
throws is retried.

The constraints follow from replay: no `Date.now()`, no `Math.random()`, no
`fetch` in a workflow body — those belong in a step. A step's arguments and
return value cross a queue, so keep them JSON-shaped and small. Put bytes in an
upload and pass the id.

## Starting one from a call

A tool starts a run and answers the turn immediately, which is the shape you
want whenever the honest answer is "that'll take a few minutes":

```ts no-check
import { tool } from "@alexkroman1/aai";
import { transcribe } from "../agent.ts";

export default tool({
  description: "Start transcribing the caller's recording",
  execute: async (_args, ctx) => {
    // `notify` makes this session take an unprompted, interruptible turn
    // when the run lands — so the agent keeps the "I'll let you know".
    const input = { recording: "…" };
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

The fields it *doesn't* take are the point: `systemPrompt`, the provider
stages, and every voice option are compile errors here rather than fields that
quietly do nothing. It produces the same definition type, so `aai dev`,
`aai build`, and `aai publish` treat it like any other agent — and
`<WorkflowFields>` and `useWorkflowRun()` render the submit-and-watch page
against the schema you already wrote.

Retries, webhooks, signals, `wake`, and the full step vocabulary are in the
[SDK reference](/agent/reference/) under `@alexkroman1/aai/step`.
