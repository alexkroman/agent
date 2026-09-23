---
"@alexkroman1/aai": minor
---

Every request-response call on the workflow API client now takes an optional
`signal`: `list`, `start`, `startAndWait`, `get`, `find`, `recent`, `wake`,
`cancel` and `uploadInfo` (the streaming calls already did). It is combined with
the client's `timeoutMs` deadline rather than replacing it, so a page that
unmounts can cancel a pending request — including a `startAndWait` the agent is
holding open for its wait budget — while the deadline still bounds a caller that
never aborts. `uploadInfo` is now also bounded by `timeoutMs`, like every other
read. Existing callers and hand-written `WorkflowApi` stubs are unaffected.
