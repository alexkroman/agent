// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `workflow-api`.
 *
 * The workflow HTTP API's client half: the factory, the call set it returns, and
 * the options it takes.
 *
 * Its own capability rather than part of `workflow`, because the two answer to
 * different audiences and would otherwise bump each other. `workflow` is what an
 * `agent.ts` names — `workflow()`, `WorkflowDef`, `WorkflowClient` — while this
 * is what something reading a RUN is written against: a page, a shell script, a
 * cron job, or a tool annotating what `ctx.workflows.get()` handed back. A route
 * added to the API moves this contract and says nothing about how a workflow is
 * declared.
 *
 * The run VOCABULARY joined it from the root barrel: the status union, the
 * snapshot and its guard, and `WorkflowOutputOf` — names whose reader is never
 * `agent.ts`, which is the root's membership test.
 *
 * `WorkflowInputOf` and `WorkflowRunOf` complete that set, and the three
 * `…Of<typeof def>` helpers travel together on purpose: a body names the INPUT,
 * a page names the OUTPUT, and a tool reporting on a run names the SNAPSHOT the
 * two compose into. Each reads the workflow's own declaration rather than
 * restating it — `WorkflowInputOf` is the schema's OUTPUT type, so a field with
 * a `.default()` is required after parsing however optional it was on the way
 * in, which is the distinction a hand-written parameter type gets wrong first
 * (and did: several workflow bodies re-implemented their own schema defaults
 * with `??`).
 *
 * **`WorkflowInputOf` and `WorkflowRunOf` are ALSO published from
 * `@alexkroman1/aai`, and this capability still owns them** — by the rule that
 * a name on both `.` and a narrower subpath belongs to the narrower one, so
 * nothing about this contract moves. What moved is where an AUTHOR finds them:
 * the paragraph above reads all three as page-and-script types, and two of them
 * are not. A `workflows/*.ts` body annotating its parameter with
 * `WorkflowInputOf` is the one annotation that is not optional, and a
 * `*_status` tool holds a `WorkflowRunOf` — both are files `workflow()` and
 * `tool()` live in, which is the ROOT barrel's membership test. Sending an
 * author to the subpath this file's own first paragraph describes as "for a
 * caller OUTSIDE the agent" was the defect. `WorkflowOutputOf` did not go with
 * them: its reader really is a page, which the template API ratchet is what
 * proved.
 *
 * Four names then LEFT for `@alexkroman1/aai/internal`, all of them the SERVER's
 * half rather than the client's: `clampWorkflowWait`, `MAX_WORKFLOW_WAIT_MS`,
 * `TERMINAL_WORKFLOW_STATUSES` and `WORKFLOW_API_PREFIX`. Each had
 * `@alexkroman1/aai-runtime` as its only importer, and this subpath is what
 * CALLS a deployed agent — a caller passes `wait` a number and never clamps, and
 * composes no URL of its own.
 *
 * Six others with the same single importer stayed, and the reason is the one
 * `sdk/workflow-api-barrel.ts` records at length: the option bags,
 * `AnyWorkflowDef` and `WorkflowBody` are the parameter and member types of
 * `WorkflowClient` and `WorkflowDef`, so moving them fails the docs build. Same
 * rule keeps `TerminalWorkflowRun`, `WorkflowRunBase`, `EventStreamFrame` and
 * `UploadPartsOptions` here.
 *
 * Re-exported from `@alexkroman1/aai/workflow-api`, which is now a barrel over
 * four modules — the agent client (a superset of the workflow one), the workflow
 * client, the SSE reader both stream with, and the call set. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type AgentClient,
  type AnyWorkflowDef,
  type ClientConfigResponse,
  createAgentClient,
  createWorkflowApiClient,
  type EventStreamFrame,
  type FindOptions,
  isTerminal,
  readEventStream,
  type StartOptions,
  type StreamOptions,
  type TerminalWorkflowRun,
  type UploadBody,
  type UploadOptions,
  type UploadParallelOption,
  type UploadPartsOptions,
  type UploadProgress,
  type UploadRef,
  type WakeUpOptions,
  type WorkflowApi,
  type WorkflowApiClientOptions,
  type WorkflowBody,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRunBase,
  type WorkflowRunOf,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowSummary,
} from "../../sdk/workflow-api-barrel.ts";
