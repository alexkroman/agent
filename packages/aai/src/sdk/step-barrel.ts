// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/step` — the surface a step body is written
 * against.
 *
 * This is the half of `/utils` that has an AUDIENCE rather than a build
 * property. That subpath's membership rule was "zod-free, so the CLI can import
 * it on every invocation without a startup cost" — true, load-bearing, and not
 * something anybody imports BY: nobody reaches for a module because of its
 * dependency graph. Seventy-nine exports served three unrelated readers (a step
 * body, a tool body, and the framework's own plumbing), so the import line said
 * nothing about which layer you were in and the reference page for the step
 * vocabulary was a list you had to filter by hand.
 *
 * **That reader is a `workflows/*.ts` module in an agent project.** Nothing here
 * is durable on its own: a call becomes a journaled step only when the body puts
 * it inside `ctx.step(name, fn)`, and outside one it runs inline on every replay
 * with no journal and no retry. So the loop is: `workflow` on the root DECLARES
 * the run and types its input, a `workflows/*.ts` module holds the body, this
 * subpath is what that body is written against, and
 * `useWorkflowRun` in `@alexkroman1/aai-ui` renders it.
 *
 * What is here is one reader's whole vocabulary, in the order a pipeline needs
 * it:
 *
 * - **Bounded fan-out** — {@link mapConcurrent}, a WINDOW over a cursor so a
 *   slow item costs only itself. Replay-safe at any width; its own doc carries
 *   the rule that makes it so.
 * - **Environment** — {@link stepEnv} / {@link requireStepEnv}. A step body has
 *   no `ToolContext`, so this is how it reads `agent({ requiredEnv })`.
 * - **HTTP** — {@link stepFetch} (HTTP/1.1-pinned; `fetch` speaks h2 and a
 *   fan-out on one connection turns a rate limit into an unreadable stream
 *   reset) and {@link multipartBody}.
 * - **Narration** — {@link stepReport} / {@link stepEmit}, what a page's progress
 *   stream renders.
 * - **Being woken** — {@link stepWebhookUrl}, the public callback URL a step
 *   hands a third party so a delivery resolves the body's `ctx.waitFor` instead
 *   of the run polling for an answer. The tool-side spelling of the same URL is
 *   `ctx.workflows.publicWebhookUrl`, which a body and its steps cannot reach.
 * - **The model** — {@link stepGenerate} (one `fetch` to the LLM gateway on the
 *   agent's own key, because the AI SDK would be megabytes in a ~7 KB artifact)
 *   and {@link stepGenerateJson} / {@link stripJsonFence}.
 * - **Audio, both directions** — {@link stepWriteUpload} / {@link stepReadUpload} /
 *   {@link stepUploadInfo}, {@link stepSpeak} and {@link encodeWav} out, and
 *   {@link stepTranscribeUpload} / {@link stepTranscribeSubmit} /
 *   {@link stepTranscribePoll} for the async job API or
 *   {@link stepTranscribeSync} for the one-request one, back in.
 * - **Retry classification** — {@link isTransientStatus} / {@link retryAfter},
 *   for a body deciding whether a failure is worth another round, and
 *   {@link stepInfo}, which says which ATTEMPT this is and whether it is the
 *   last. That is what lets a step degrade rather than fail — a smaller model on
 *   the final try beats a failed run — and it is the DevKit's `getStepMetadata()`
 *   with the two differences its own module doc gives.
 *
 * The zod-free budget still applies here and is now a property of BOTH
 * subpaths rather than the reason one of them exists: a `workflows/*.ts` module
 * is bundled separately, so the root barrel's graph would ride into the step
 * bundle. That is also why `stepSpeak` carries the SLOT and the WAV framing
 * rather than a synthesizer, the same split {@link stepFetch} makes with its
 * undici dispatcher.
 *
 * Two neighbours that are deliberately elsewhere. The failure a body THROWS
 * (`toStepError` / `throwStepError` / `throwFatalStepError`, and the
 * `FatalError` / `RetryableError` they resolve to) is on
 * `@alexkroman1/aai/step-errors`, so that importing a classifier is an opt-in
 * rather than something every `/step` reader pays for. And the durable wait is
 * `ctx.sleep` on the `WorkflowCtx` the engine hands the body — this SDK
 * owns what is INSIDE a step and never the steps.
 *
 * @module step
 */

// Listed rather than `export *`, the same choice `workflow-api-barrel.ts`
// makes and for the same reason: a wildcard needs a lint suppression, and this
// surface is checked by `pnpm check:api-report` and `check:api-contracts`
// anyway, so an export missing from this list fails a gate rather than
// silently leaving the subpath.
export {
  TRANSCRIBE_TIMEOUT_MS,
  TranscribeError,
  type TranscribeRequestOptions,
} from "./_transcribe-shared.ts";
export { mapConcurrent } from "./map-concurrent.ts";
export { type StepInfo, stepInfo } from "./step-attempt.ts";
export { requireStepEnv, stepEnv } from "./step-env.ts";
export {
  type MultipartBody,
  type MultipartPart,
  multipartBody,
  type StepFetchInit,
  StepTransportError,
  stepFetch,
} from "./step-fetch.ts";
export { StepGenerateError, type StepGenerateOptions, stepGenerate } from "./step-generate.ts";
export {
  type StepGenerateJsonOptions,
  stepGenerateJson,
  stripJsonFence,
} from "./step-generate-json.ts";
export { stepEmit, stepReport } from "./step-report.ts";
export { isTransientStatus, retryAfter } from "./step-retry.ts";
export {
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  stepSpeak,
} from "./step-speak.ts";
export {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
  TRANSCRIBE_API,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_UPLOAD_TIMEOUT_MS,
  TRANSCRIBE_WINDOW_BYTES,
  type TranscribeProgress,
  type TranscribeSubmitOptions,
  type Transcript,
} from "./step-transcribe.ts";
export {
  stepTranscribeSync,
  TRANSCRIBE_SYNC_ENDPOINT,
  TRANSCRIBE_SYNC_MODEL,
  TRANSCRIBE_SYNC_TIMEOUT_MS,
  type TranscribeSyncOptions,
} from "./step-transcribe-sync.ts";
export {
  type ReadUploadOptions,
  stepReadUpload,
  stepUploadInfo,
  type UploadInfo,
  // `UploadInfo.ranges` mentions this, and a type a public signature MENTIONS but
  // does not export is a docs-build warning — which `treatWarningsAsErrors` makes a
  // failed build. `runtime-barrel.ts` carries the same note for the same reason.
  type UploadRange,
  type UploadSlice,
} from "./step-uploads.ts";
export { stepRequireCompleteUpload, UploadIncompleteError } from "./step-uploads-complete.ts";
export { stepWriteUpload, type WriteUploadOptions } from "./step-uploads-write.ts";
export { stepWebhookUrl } from "./step-webhook.ts";
export { encodeWav, type PcmFormat, pcmDurationMs, WAV_HEADER_BYTES, wavHeader } from "./wav.ts";
