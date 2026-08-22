// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/workflow-api` — the client side of a deployed agent's HTTP
 * API, from one import path.
 *
 * Start with {@link createAgentClient} — one object for everything one agent
 * answers. {@link createWorkflowApiClient} is the narrower one, for a caller
 * that genuinely only has workflows (a page already knows what it is): the
 * agent client CALLS it, so the two are a superset and its narrower factory
 * rather than two implementations, and the barrel exists because pointing the
 * subpath at either one directly would be an import cycle.
 *
 * It also owns the RUN vocabulary — the option bags, the snapshot union, its
 * guard, and {@link WorkflowOutputOf} — which used to sit on the root barrel beside
 * `agent()` and `tool()`. See the re-export below for the line that puts it
 * here.
 *
 * @module workflow-api
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
/**
 * What a RUN is: the per-call option bags, the status union and its terminal
 * set, the snapshot a caller reads, and the guard that narrows one.
 *
 * Here rather than on the root barrel because the reader is never `agent.ts`.
 * The root's membership test is "would an `agent.ts`, a tool module, or a
 * `workflow()` NAME it", and these seventeen names fail it: a page renders a run,
 * a script polls one, and a tool body that starts one gets a typed value back
 * without importing anything. Declaring a workflow is still `workflow()` on the
 * root; this is everything about the run it starts.
 *
 * {@link WorkflowOutputOf} is the type a page's `useWorkflowRun<…>` is
 * parameterized by, which is the clearest case of all — it is imported by a
 * `client.tsx`, beside `createWorkflowApi` from `@alexkroman1/aai-ui`, from
 * this subpath.
 */
export type {
  AnyWorkflowDef,
  WorkflowBody,
  // `WorkflowDef` and `WorkflowClient` belong to the `workflow` capability and
  // stay on the ROOT — they are what an `agent.ts` declares with. They are
  // reachable here only because the run types' own docs `{@link}` them, and a
  // type a public signature's documentation names must be reachable from the
  // entry point or the docs build fails.
  WorkflowDef,
  WorkflowOutputOf,
  WorkflowSummary,
} from "./workflow.ts";
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
export type { WorkflowClient } from "./workflow-client.ts";
export type {
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
} from "./workflow-options.ts";
export {
  clampWorkflowWait,
  isTerminal,
  MAX_WORKFLOW_WAIT_MS,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminalWorkflowRun,
  // Re-exported because `WorkflowRunSnapshot` intersects it into every member, so
  // it is part of a public type's shape — TypeDoc fails the docs build for a type
  // referenced by a public signature but not reachable from the entry point.
  type WorkflowRunBase,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from "./workflow-run.ts";
