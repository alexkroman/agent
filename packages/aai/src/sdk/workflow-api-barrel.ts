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
 * It also owns the RUN vocabulary — the snapshot union, its guard, and
 * {@link WorkflowOutputOf} — which used to sit on the root barrel beside
 * `agent()` and `tool()`. See the re-export below for the line that puts it
 * here.
 *
 * **What this subpath is NOT is the SERVER's half.** Four names were here that
 * only the thing ANSWERING these routes ever needed — the wait clamp
 * (`clampWorkflowWait`) and its ceiling (`MAX_WORKFLOW_WAIT_MS`), the
 * terminal-status list (`TERMINAL_WORKFLOW_STATUSES`), and the route prefix
 * (`WORKFLOW_API_PREFIX`) — and they are on `@alexkroman1/aai/internal` now.
 * `clampWorkflowWait` is the clearest: its own doc says both ends share it, and
 * the browser client does share it, through a RELATIVE import inside
 * `workflow-api-client.ts`. The public export existed so `aai-runtime` could
 * reach the same copy, which is a fact about our packaging rather than an
 * affordance a caller used — a caller passes `wait` a number and the client
 * clamps it.
 *
 * **Six more were tried and PUT BACK, and the docs build is what said no.** The
 * four `ctx.workflows` option bags (`StartOptions`, `FindOptions`,
 * `StreamOptions`, `WakeUpOptions`) plus `AnyWorkflowDef` and `WorkflowBody`
 * also have `aai-runtime` as their only in-repo importer, which is the evidence
 * that reads like a case for moving them — and it is the wrong evidence. They
 * are the PARAMETER and MEMBER types of `WorkflowClient` and `WorkflowDef`,
 * both of which are on the ROOT barrel because `ToolContext.workflows` and
 * `workflow()` name them; in-repo tool code passes object literals, so nobody
 * imports the bag while every author reads it. Moved, TypeDoc reports six
 * "referenced by … but not included in the documentation" warnings and
 * `treatWarningsAsErrors` fails the build — the same rule `WorkflowDef` and
 * `WorkflowRunBase` are already re-exported here under. Suppressing it via
 * `intentionallyNotExported` would leave `options?: StartOptions` on the
 * `ctx.workflows` reference page with nowhere to click, which is a worse
 * outcome than a wide subpath.
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
 * What a RUN is: the per-call option bags, the status union, the snapshot a
 * caller reads, and the guard that narrows one.
 *
 * Here rather than on the root barrel because the reader is never `agent.ts`.
 * The root's membership test is "would an `agent.ts`, a tool module, or a
 * `workflow()` NAME it", and these names fail it: a page renders a run, a script
 * polls one, and a tool body that starts one gets a typed value back without
 * importing anything. Declaring a workflow is still `workflow()` on the root;
 * this is everything about the run it starts.
 *
 * {@link WorkflowOutputOf} is the type a page's `useWorkflowRun<…>` is
 * parameterized by, which is the clearest case of all — it is imported by a
 * `client.tsx`, beside `createWorkflowApi` from `@alexkroman1/aai-ui`, from
 * this subpath.
 */
export type {
  AnyWorkflowDef,
  // `WorkflowCtx` is `WorkflowBody`'s second parameter and these three are its
  // own methods' option bags, so all four travel with it under the rule the
  // comment below states: a type a public signature names must be reachable
  // from this entry point.
  SleepOptions,
  StepOptions,
  StepSchemaOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowBody,
  WorkflowCtx,
  // `WorkflowDef` and `WorkflowClient` belong to the `workflow` capability and
  // stay on the ROOT — they are what an `agent.ts` declares with. They are
  // reachable here only because the run types' own docs `{@link}` them, and a
  // type a public signature's documentation names must be reachable from the
  // entry point or the docs build fails.
  WorkflowDef,
  // The three `…Of<typeof def>` helpers travel together: a body names the
  // input, a page names the output, and a tool reporting on a run names the
  // snapshot the two compose into.
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowRunOf,
  WorkflowSummary,
} from "./workflow.ts";
// The narrower factory, the call set, and the upload types a caller names.
// `WORKFLOW_API_PREFIX` was here too and is on `/internal`: a caller composes
// no URL of its own, and the two things that do — the runtime serving these
// routes and the client building them — are both framework code.
// Listed rather than `export *`, which is what
// every other barrel here does: a wildcard needs a lint suppression, and the
// surface is checked by `pnpm check:api-report` and `check:api-contracts`
// anyway, so an export missing from this list fails a gate rather than
// silently leaving the subpath.
export {
  createWorkflowApiClient,
  type UploadBody,
  type UploadInfo,
  type UploadOptions,
  type UploadParallelOption,
  type UploadPartsOptions,
  type UploadProgress,
  type UploadRange,
  type UploadRef,
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
  isTerminal,
  // The type `isTerminal` narrows TO, so it is part of that guard's signature —
  // same rule as `WorkflowRunBase` below, which is why neither followed
  // `TERMINAL_WORKFLOW_STATUSES` to `/internal`.
  type TerminalWorkflowRun,
  // Re-exported because `WorkflowRunSnapshot` intersects it into every member, so
  // it is part of a public type's shape — TypeDoc fails the docs build for a type
  // referenced by a public signature but not reachable from the entry point.
  type WorkflowRunBase,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from "./workflow-run.ts";
