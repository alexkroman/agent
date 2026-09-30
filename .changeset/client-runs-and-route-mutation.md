---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Route plumbing a device-twin page kept writing for itself, in the SDK:

- `clientRunsRoutes({ path?, recentMs?, limit?, include?, progressFor?, detail? })` on `@alexkroman1/aai` returns the `"GET <path>"` / `"DELETE <path>/:runId"` pair (default `/tasks`) to spread into `agent({ routes })`. The list answers `{ runs: ClientRun[] }` for `?client=` — pending and running runs plus finished ones created within `recentMs` (default 10 minutes), oldest first; `pending` is said as `waiting`, the title is the run's label, and `detail` is the option's answer, else a failure as `spokenErrorReason` says it, else a running run's newest progress line. The cancel answers `{ cancelled }` and 404s any run whose correlation key is not the asking client. Both require `?client=`. `ClientRun`, `ClientRunStatus`, `ClientRunsResponse` and `ClientRunsRoutesOptions` are exported with it.
- `useRouteMutation({ client?, onSettled? })` on `@alexkroman1/aai-ui`: `run(method, path, body?, { key? })` never rejects (it resolves `undefined` on failure), `busy` names the newest write in flight, `error` is the newest settled write's `{ error }` sentence, `clearError()` forgets it, and `onSettled` (a `useRoute`'s `reload`) runs after each write. Nothing runs after unmount.
- `useClientRuns(path = "/tasks", { pollMs = 5000, client? })` on `@alexkroman1/aai-ui`: `{ runs, error, reload, cancel(runId), cancelling }` over a `clientRunsRoutes()` pair.
- `errorMessage` and the `ClientRun` row types are re-exported from `@alexkroman1/aai-ui`.
