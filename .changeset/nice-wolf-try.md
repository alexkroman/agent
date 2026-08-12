---
"@alexkroman1/aai": minor
---

Add `WorkflowOutputOf<D>`, so a static page derives its run's output type from the workflow instead of restating it. `useWorkflowRun<R>` is what narrows a completed run to a typed `output`, and a page hand-wrote `R` — a second declaration of a shape the agent already owns, with nothing checking the two agree. The reason given for that (importing the agent would drag the server graph into the page bundle) does not survive `import type`, which is ERASED; it is the same wrong premise `aai-ui` already corrected when it stopped restating `WorkflowRunSnapshot`. So this needs no generated `.d.ts` and no build step: export the workflow from `agent.ts` and write `useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId)`. Re-exported from `@alexkroman1/aai-ui` so a page needs one import, and `transcription-desk` now derives its type rather than declaring a parallel copy.
