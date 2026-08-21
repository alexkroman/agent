// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/workflow-api` — the client side of a deployed agent's HTTP
 * API, from one import path.
 *
 * Four modules sit behind it, and the split is a dependency one rather than a
 * taste one: `agent-client.ts` is a SUPERSET of `workflow-api-client.ts` (it
 * calls the narrower factory), so the subpath cannot be either file — pointing
 * it at the client and re-exporting the agent client from there is an import
 * cycle, which is what this barrel exists to break. `event-stream.ts` is the
 * parser both of them read a stream with, and `workflow-api-types.ts` holds the
 * call set.
 *
 * Start with `createAgentClient` — one object for everything one agent answers.
 * `createWorkflowApiClient` is the narrower one, for a caller that genuinely
 * only has workflows (a page already knows what it is).
 */

// One client for the WHOLE of an agent's HTTP API: the workflow routes plus the
// front door (`GET /client-config`).
export {
  type AgentClient,
  type ClientConfigResponse,
  createAgentClient,
} from "./agent-client.ts";
// The SSE parser both run streams are decoded with. Public because a caller that
// took the raw `Response` from `watch` needs it, and because the browser client
// would otherwise carry a second copy of a stream parser.
export { type EventStreamFrame, readEventStream } from "./event-stream.ts";
// The narrower factory, the call set, the prefix both ends resolve, and the
// upload types a caller names. Listed rather than `export *`, which is what
// every other barrel here does: a wildcard needs a lint suppression, and the
// surface is checked by `pnpm check:api-report` and `check:api-contracts`
// anyway, so an export missing from this list fails a gate rather than
// silently leaving the subpath.
export {
  createWorkflowApiClient,
  type UploadBody,
  type UploadInfo,
  type UploadOptions,
  type UploadParallel,
  type UploadPartsSettings,
  type UploadProgress,
  type UploadRange,
  type UploadRef,
  WORKFLOW_API_PREFIX,
  type WorkflowApi,
  type WorkflowApiClientOptions,
} from "./workflow-api-client.ts";
