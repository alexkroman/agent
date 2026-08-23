---
"@alexkroman1/aai": major
---

Stop erasing types the SDK already computed, own the helpers the templates had
copied past the third time, and change one signature that had to break.

**BREAKING — `stubUploads` returns `StubUploads`, not a bare `() => void`.**
`const restore = stubUploads(files); restore();` becomes
`const uploads = stubUploads(files); uploads.restore();`. It was the only fake
in its family whose shape a spec had to remember was different, and the only
way to assert that a step WROTE something was to read it back through
`uploadInfo`/`readUpload` — through the seam the write went out on, so a broken
write and a broken read were indistinguishable. `writes` is the log and `read`
is a synchronous peek beside `restore`.

**Result types.** `dialog.tool`, `slot.tool` and `slot.updateTool` each bound a
result type parameter and returned `ToolDef<P>` — that is, `unknown` — where
`tool()` had kept it all along, so `InferToolOutput` was useless for exactly
the tools a stateful agent writes. They answer
`ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>` and `ToolDef<P, R>`
now. `DialogToolDef.sendFrom` takes `Exclude<NoInfer<R>, ToolFailure>`: `R` was
inferred from two positions, so whether the parameter meant anything depended
on whether `sendFrom` was written above or below `execute` in the object
literal — above it, the parameter was `unknown` and its narrowing silently
stopped checking anything while still compiling.

**A dialog can be a plain state map.** `dialog(key, { initial, states })` takes
`instruction`, `on`, `final`, `initial` and nested `states`, builds the same
XState machine (so a persisted dialog resumes across the change), and
synthesizes the event union from the `on` keys. `instruction` is a typed field
rather than an untyped `meta` lookup that failed silently when misspelled. The
machine overload stays for everything the spec form deliberately cannot express.

**New on `@alexkroman1/aai/step-files`:** `withTempDir`, `readUploadToFile`,
`writeUploadFromFile` and `STEP_FILE_WINDOW_BYTES`, for the upload/local-file
round trip ffmpeg needs a real path for. Its own subpath rather than `/step`,
because `/step` is held at module scope by every workflow file and a `node:fs`
import there dies at replay.

**New on `@alexkroman1/aai/step-errors`:** `throwFfmpegStepError`, plus six
pre-classified callers (`stepGenerateClassified`, `stepGenerateJsonClassified`
and the four `stepTranscribe*Classified`) — the same step calls with the
`.catch(throwStepError)` every project was writing beside them, and forgetting
on the arm where a `TranscribeError`'s `retryable: false` is the difference
between reporting a bad recording and re-uploading it until the attempts run out.

**New on `@alexkroman1/aai/utils`:** `formatBytes`, `formatDuration`,
`countWords` and `plural`. Non-localized, with every documented output pinned —
one template printed the same 64-minute recording as `1:04:09` from its workflow
and `64:09` from its page.

**New on `@alexkroman1/aai/workflow-api`:** `WorkflowInputOf` and
`WorkflowRunOf`, beside `WorkflowOutputOf`. `WorkflowInputOf` is the schema's
OUTPUT type, so a field with a `.default()` is required after parsing and a body
has nothing left to re-implement with `??`.

**New on `@alexkroman1/aai/testing`:** `ok`/`okPosition` (unwrap what a tool
answered on the registry-lookup path, throwing and QUOTING a refusal rather than
casting past it), `parseToolInput`/`toolInputIssues` and
`parseSchemaInput`/`schemaInputIssues` (ask a schema what it accepts without
reaching through `~standard`), `stubTranscribe` (the four transcription
endpoints answered in memory, refusing by HTTP STATUS so the SDK's own
classification is exercised rather than replaced), and `ToolContextOverrides` —
`createToolContext` took a `Partial<ToolContext>`, which under
`exactOptionalPropertyTypes` refuses an explicitly-undefined value, so callers
wrote a conditional spread to pass an optional one. `runTool`'s `args` is
optional now, which sixty-six call sites were passing `{}` to satisfy.
`@alexkroman1/aai/testing/vitest` gains `installStubUploads`,
`installStubStepFetch`, `installStubReporter`, `installStubSpeech` and
`installStubTranscribe` — the same fakes with `onTestFinished(restore)` done.

**`WorkflowClient.lastLine(runId)`** reads a run's newest progress chunk, or
`undefined`. The composition it replaces HANGS: a progress channel is never
closed, so `stream()` on a run that has written nothing waits forever, and a
voice agent's tool call stops mid-turn with no error and nothing in a log.

**`buildSystemPrompt` strips a leading verbatim `DEFAULT_SYSTEM_PROMPT`.** The
constant's own doc used to say `agent({ systemPrompt })` replaced the shipped
prompt and gave a worked example interpolating it; it is APPENDED, so following
that example sent ~10,000 characters twice, under two different precedence
headers. The doc says appended now, and an agent shipping the doubled form is
corrected on upgrade.

`@alexkroman1/aai-ui` moves with the fixed release group and gains
`ConsoleShell` (public, because every custom chrome rebuilt the frame without
the `role="alert"` the error banner needs once the fatal latch has fired),
`useConversation` (the message/tool-call interleave, the streaming bubble, the
live transcript row and the thinking rule, headless — three template chromes
dropped all four at once and one rendered none of its fifteen tools),
`useDownloadUrl` (the object-URL lifecycle, revoke included),
`WORKFLOW_STATUS_LABELS`, `wake`/`cancel` on both workflow submissions,
`<WorkflowProgress lines>`, and four display fields on `ClientConfig`.
