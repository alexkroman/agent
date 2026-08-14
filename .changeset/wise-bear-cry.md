---
"@alexkroman1/aai": minor
---

Add a synchronous wait mode to the workflow HTTP API, and form components for workflow apps.

`POST /workflows/runs` accepts a `wait` budget and `GET /workflows/runs/:id` a `?wait=` query: the request is answered when the run reaches a terminal status or when the budget expires, whichever is first. An expired budget answers the running snapshot at 202 rather than an error, so waiting degrades to the asynchronous behaviour that was already there. On the client this is `api.startAndWait()` and `api.get(runId, { wait })`.

aai-ui gains `Form` and its field components (`TextField`, `NumberField`, `TextAreaField`, `SelectField`, `CheckboxField`, `FileField`, `SubmitButton`, `Field`), `WorkflowFields` — one control per scalar property of a workflow's declared input schema — and the `useWorkflows` / `useWorkflowSubmit` hooks.

The `transcription-workflow` template is now a workflow app: an upload form over a run that parks on `createWebhook()` and fans out over what the callback delivered.
