---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Three things the templates kept rebuilding move into the SDK.

`describeMedia(info)` on `@alexkroman1/aai/ffmpeg` turns a `probeMedia` result into the `41:20 of aac` a progress line wants, degrading a field at a time (`41:20`, `aac`, `the recording`) when ffprobe did not report one. `call-audit` and `transcription-workflow` each carried the same function.

`dialogResultSchema(result)` on `@alexkroman1/aai/testing` is the envelope a `dialog.tool` answers with — `{ result, state, done, instruction? }` — as a zod schema around the tool's own, for an eval reading a serialized result back through `toolResultIn`. Three template evals had written it out under a comment saying the shape was the SDK's.

`describeEval` now gives the workflow engine it opens beside a voice agent the same env `describeWorkflowEval` gives a workflow app: in stub mode a declared key nobody has is a placeholder, so a step's `requireStepEnv` reaches the scripted provider instead of throwing over a credential the case was never going to use. The two templates that hand off to a run drop the `EVAL_ENV` they each carried for exactly this.
