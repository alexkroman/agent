// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-workflow`.
 *
 * Testing code that STARTS, READS or RUNS durable workflows: the recording
 * `ctx.workflows` (`createRecordingWorkflows`), the rejecting one a spec
 * overrides piecemeal (`createStubWorkflows`, and its `/vitest` installer), a
 * run snapshot built without a cast (`createRunSnapshot`), and a recording
 * `WorkflowContext` for driving a body directly (`createWorkflowContext`).
 *
 * Split off `testing` (which kept the tool-context and model fakes) because the
 * workflow fakes move with the workflow API and every such move renumbered the
 * one big contract every template spec imports. Part of the `testing` family:
 * `aai-runtime`'s `testing-stubs` door mirrors the whole family.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  createRecordingWorkflows,
  createRunSnapshot,
  createStubWorkflows,
  createWorkflowContext,
  type RecordedSignal,
  type RecordedSleep,
  type RecordedStart,
  type RecordedStep,
  type RecordingWorkflows,
  type RecordingWorkflowsOptions,
  type RunSnapshotOverrides,
  WORKFLOW_CONTEXT_NOW,
  type WorkflowContextOptions,
  type WorkflowContextRecorder,
} from "../../sdk/testing-barrel.ts";
export {
  installStubWorkflows,
  type StubWorkflowsOptions,
} from "../../sdk/testing-vitest-barrel.ts";
