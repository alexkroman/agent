---
title: Workflow evals
description: A background job has no session, so it gets its own suite.
---

A [background job](/agent/more/background-jobs/) has no session, no turns and no
`stubReply`. It gets a suite of its own:

```ts
import {
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
import { completedOutput } from "@alexkroman1/aai-runtime/eval";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import agentDef from "virtual:aai/agent";
import { expect } from "vitest";
import { z } from "zod";

describeWorkflowEval(agentDef, (test) => {
  test("transcribes the recording it was given", async ({ app, mode }) => {
    installStubUploads({ upl_1: { bytes: new Uint8Array(64), name: "standup.wav" } });
    if (mode === "stub") installStubTranscribe({ text: "hello there" });

    const run = await app.run("transcribe", { recording: "upl_1" });

    expect(run.status).toBe("completed");
    const output = z.object({ text: z.string() }).parse(completedOutput(run));
    expect(output.text).toMatch(/hello/i);
  });
});
```

`describeWorkflowEval` opens the app for each case and closes it afterwards. A
case body is handed two things: `app`, to start runs on, and `mode`, saying
which kind of run it got.

## Installing the fakes

There is no `stubReply` here because a workflow has no single model to script.
Its steps reach a model, a transcription endpoint, an upload store, a stranger's
web server — and each of those already has a published fake on
`@alexkroman1/aai/testing/vitest`:

| Fake | Stands in for |
| --- | --- |
| `installStubUploads` | the upload store a step reads bytes from |
| `installStubTranscribe` | transcription |
| `installStubSpeech` | speech synthesis |
| `installStubStepFetch` | a step's outbound `fetch` |

So a case installs what it needs and branches on `mode`:

- **`mode === "stub"`** — no provider key resolved. Fake anything that would
  otherwise leave the machine.
- **`mode === "live"`** — a key is present, and the real endpoints are dialled.
  Install only the fakes you want either way.

A case that means nothing against a fake takes `{ live: true }` and is skipped
in stub mode. Reach for it when a step has to reach the far side for the claim
to hold: a transcript that has to be *of* the audio, a summary that has to be
*of* the page.

## Reading a run

`app.run(name, input)` starts a run and waits for it. Pass the exported workflow
instead of its name and the input and output are typed.

`completedOutput(run)` is the reader for the result. It throws when the run did
not complete, naming the workflow and the reason, rather than handing back an
`undefined` an assertion would pass against.

`app.settle(runId)` reads a run something else started — a voice tool that hands
off to one. `app.settleAll()` waits for every run the case began, which a case
that installed a fake owes before it ends.

:::caution[The engine an eval runs a body on is not durable]
No journal, no replay, no per-step retry. A green run here says the body does
the work. It says nothing about resuming after step 27.
:::

## Next

- [Your own UI](/agent/more/custom-ui/) — the page a workflow app serves
- [Publish](/agent/deploy/publish/) — shipping it
- [Evals](/agent/build/evals/) — the same questions asked of a voice session, and
  why one run is not a verdict
