---
"@alexkroman1/aai": minor
---

A durable run can now tell the caller it finished: `ctx.workflows.start(def, input, { notify })` makes the session that started it take an unprompted, interruptible turn built from the run's own output — the promise a voice agent used to make ("I'll let you know") with no way to keep it. Pipeline mode only; S2S has no verb for an unprompted turn and logs a no-op. Uploads now accept 2 GiB by default (`AAI_MAX_UPLOAD_BYTES` moves it) — the old 256 MB cap refused an ordinary stereo recording — and `useWorkflowRuns` renders a workflow's history so a page need not ask for a run id.
