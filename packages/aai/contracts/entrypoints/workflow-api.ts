// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `workflow-api`.
 *
 * The workflow HTTP API's client half: the factory, the call set it returns, the
 * options it takes, and the path prefix both ends resolve.
 *
 * Its own capability rather than part of `workflow`, because the two answer to
 * different audiences and would otherwise bump each other. `workflow` is what an
 * `agent.ts` names — `workflow()`, `WorkflowDef`, `WorkflowClient` — while this
 * is what something reading a RUN is written against: a page, a shell script, a
 * cron job, or a tool annotating what `ctx.workflows.get()` handed back. A route
 * added to the API moves this contract and says nothing about how a workflow is
 * declared.
 *
 * The run VOCABULARY joined it from the root barrel: the option bags, the status
 * union and its terminal set, the snapshot and its guard, `WorkflowOutputOf`,
 * and the wait cap both ends clamp with. Seventeen names whose reader is never
 * `agent.ts`, which is the root's membership test.
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
  clampWorkflowWait,
  createAgentClient,
  createWorkflowApiClient,
  type EventStreamFrame,
  type FindOptions,
  isTerminal,
  MAX_WORKFLOW_WAIT_MS,
  readEventStream,
  type StartOptions,
  type StreamOptions,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminalWorkflowRun,
  type UploadBody,
  type UploadOptions,
  type UploadParallel,
  type UploadPartsSettings,
  type UploadProgress,
  type UploadRef,
  type WakeUpOptions,
  WORKFLOW_API_PREFIX,
  type WorkflowApi,
  type WorkflowApiClientOptions,
  type WorkflowBody,
  type WorkflowOutputOf,
  type WorkflowRunBase,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowSummary,
} from "../../sdk/workflow-api-barrel.ts";
