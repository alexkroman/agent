// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 1.
 *
 * Epoch 2 widened `createWorkflowApi`'s return from `WorkflowApi` to the full
 * `AgentClient` (a documented superset) and re-exported `AgentClient` here.
 * A widened return is only safe if epoch-1 code that stored the value in a
 * `WorkflowApi`-typed binding still compiles — which is what the annotation
 * below asserts, and the reason it is written out rather than inferred.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 43 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import type {
  AudioResultCaptions,
  AudioResultProps,
  SubmitInputOf,
  UploadStatus,
  UseDownloadUrlOptions,
  UseDownloadUrlResult,
  UseWorkflowProgressResult,
  UseWorkflowRunResult,
  UseWorkflowRunsOptions,
  UseWorkflowRunsResult,
  UseWorkflowStreamOptions,
  UseWorkflowSubmitOptions,
  UseWorkflowsOptions,
  UseWorkflowsResult,
  WorkflowApi,
  WorkflowApiOptions,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowPendingNoteProps,
  WorkflowRun,
  WorkflowRunErrorProps,
  WorkflowRunPanelProps,
  WorkflowRunStatus,
  WorkflowStreamSubmission,
  WorkflowSubmission,
  WorkflowSummary,
} from "../../../index.ts";
import {
  AudioResult,
  createWorkflowApi,
  isTerminal,
  UploadProgressBar,
  useDownloadUrl,
  useRunKey,
  useWorkflowProgress,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  useWorkflows,
  WORKFLOW_STATUS_LABELS,
  WorkflowPendingNote,
  WorkflowProgress,
  WorkflowRunError,
  WorkflowRunPanel,
} from "../../../index.ts";

// The annotation IS the assertion: a superset must remain assignable to it.
const api: WorkflowApi = createWorkflowApi();

// The hoisted-client pattern epoch 1 taught. Epoch 2 defaults it, but passing
// one explicitly is still how a page reaches a different `baseUrl`.
export const remote: WorkflowApi = createWorkflowApi({ baseUrl: "https://example.invalid" });

export const listed = async (): Promise<unknown> => api.list();

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  workflowInputOf: WorkflowInputOf<never>;
  workflowOutputOf: WorkflowOutputOf<never>;
  workflowRunStatus: WorkflowRunStatus;
  workflowSummary: WorkflowSummary;
  audioResultCaptions: AudioResultCaptions;
  audioResultProps: AudioResultProps;
  submitInputOf: SubmitInputOf<never>;
  uploadStatus: UploadStatus;
  useDownloadUrlOptions: UseDownloadUrlOptions;
  useDownloadUrlResult: UseDownloadUrlResult;
  useWorkflowProgressResult: UseWorkflowProgressResult;
  useWorkflowRunResult: UseWorkflowRunResult;
  useWorkflowRunsOptions: UseWorkflowRunsOptions;
  useWorkflowRunsResult: UseWorkflowRunsResult;
  useWorkflowStreamOptions: UseWorkflowStreamOptions;
  useWorkflowSubmitOptions: UseWorkflowSubmitOptions;
  useWorkflowsOptions: UseWorkflowsOptions;
  useWorkflowsResult: UseWorkflowsResult;
  workflowApiOptions: WorkflowApiOptions;
  workflowPendingNoteProps: WorkflowPendingNoteProps;
  workflowRun: WorkflowRun;
  workflowRunErrorProps: WorkflowRunErrorProps;
  workflowRunPanelProps: WorkflowRunPanelProps<string>;
  workflowStreamSubmission: WorkflowStreamSubmission;
  workflowSubmission: WorkflowSubmission;
};

export const epoch1Values = [
  AudioResult,
  UploadProgressBar,
  WORKFLOW_STATUS_LABELS,
  WorkflowPendingNote,
  WorkflowProgress,
  WorkflowRunError,
  WorkflowRunPanel,
  isTerminal,
  useDownloadUrl,
  useRunKey,
  useWorkflowProgress,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  useWorkflows,
] as const;
