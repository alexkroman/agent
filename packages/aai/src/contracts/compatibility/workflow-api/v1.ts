// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 1.
 *
 * A script that reads and drives RUNS of a deployed agent, as it was written
 * against epoch 1: the two client factories, the call set and every option bag,
 * the SSE reader, and the three `…Of<typeof def>` helpers a body, a page and a
 * status tool name a run through. It must keep compiling against current
 * source for as long as epoch 1 is advertised as supported.
 *
 * What epoch 2 moved, and why this file still compiles: `WorkflowInputOf`
 * gained two readings — a Standard Schema directly, and the two-phase
 * declaration's `body` — behind the `run` reading this file uses, which is
 * unchanged. A changed conditional type is one the probe cannot prove either
 * way, which is why this example exists.
 */

import { z } from "zod";
import {
  type AgentClient,
  type AnyWorkflowDef,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
  createAgentClient,
  createWorkflowApiClient,
  type EventStreamFrame,
  type FindByKeyOptions,
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
  type WorkflowApiCallOptions,
  type WorkflowApiClientOptions,
  type WorkflowBody,
  type WorkflowFollowOutputOptions,
  type WorkflowGetOptions,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRunBase,
  type WorkflowRunListOptions,
  type WorkflowRunOf,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowStartAndWaitOptions,
  type WorkflowStartOptions,
  type WorkflowStreamOutputOptions,
  type WorkflowSummary,
} from "../../../sdk/workflow-api-barrel.ts";

// --- The clients ------------------------------------------------------------

const options: WorkflowApiClientOptions = {
  baseUrl: "https://audit.example.com",
  token: "secret",
  timeoutMs: 30_000,
};
export const api: WorkflowApi = createWorkflowApiClient(options);
export const client: AgentClient = createAgentClient({ baseUrl: options.baseUrl });

// --- The def a page names a run through -------------------------------------

const audit = {
  description: "Audit a recording.",
  input: z.object({ uploadId: z.string() }),
  output: z.object({ score: z.number() }),
  run: async (input: { uploadId: string }) => ({ score: input.uploadId.length }),
};
export const anyAudit: AnyWorkflowDef<{ score: number }> = audit;

export type AuditInput = WorkflowInputOf<typeof audit>;
export type AuditOutput = WorkflowOutputOf<typeof audit>;
export type AuditRun = WorkflowRunOf<typeof audit>;
export const body: WorkflowBody<AuditInput, AuditOutput> = audit.run;

// --- Starting and reading runs -------------------------------------------------

export async function runAudit(
  uploadId: string,
  signal: AbortSignal,
): Promise<AuditOutput | undefined> {
  const startOptions: WorkflowStartOptions = { key: uploadId, signal };
  const runId = await api.start("audit", { uploadId }, startOptions);
  const getOptions: WorkflowGetOptions = { wait: 30_000, signal };
  const run = await api.get(runId, getOptions);
  if (isTerminal(run)) {
    const done: TerminalWorkflowRun = run;
    return done.status === "completed" ? (done.output as AuditOutput) : undefined;
  }
  const startAndWait: WorkflowStartAndWaitOptions = { key: uploadId, wait: 60_000, signal };
  const waited: WorkflowRunSnapshot = await api.startAndWait("audit", { uploadId }, startAndWait);
  return waited.status === "completed" ? (waited.output as AuditOutput) : undefined;
}

export async function upload(file: UploadBody): Promise<UploadRef> {
  const parts: UploadPartsOptions = { partBytes: 5_000_000, concurrency: 2 };
  const parallel: UploadParallelOption = parts;
  const uploadOptions: UploadOptions = {
    name: "call.wav",
    type: "audio/wav",
    parallel,
    onProgress: (progress: UploadProgress) => {
      if (progress.fraction !== undefined && progress.fraction > 1) throw new Error("over");
    },
  };
  return await api.upload(file, uploadOptions);
}

export async function latest(): Promise<WorkflowRunStatus[]> {
  const summaries: WorkflowSummary[] = await api.list();
  const list: WorkflowRunListOptions = { limit: 10 };
  const name = summaries[0]?.name ?? "audit";
  const recent = await api.recent(name, list);
  const found = await api.find(name, "key-1", { limit: 1 });
  const statuses: WorkflowRunStatus[] = [];
  for (const run of [...recent, ...found]) {
    const base: WorkflowRunBase = run;
    if (base.key !== undefined) statuses.push(run.status);
  }
  return statuses;
}

export async function follow(runId: string, signal: AbortSignal): Promise<string[]> {
  const call: WorkflowApiCallOptions = { signal };
  const stream: WorkflowStreamOutputOptions = { namespace: "progress", startIndex: 0, signal };
  const followOutput: WorkflowFollowOutputOptions = { namespace: "progress", fromIndex: 0, signal };
  const wake: WakeUpOptions = { correlationIds: ["sleep:1"] };
  const seen: string[] = [];
  const response = await api.streamOutput(runId, stream);
  if (response.body) {
    for await (const frame of readEventStream(response.body, signal)) {
      const typed: EventStreamFrame = frame;
      seen.push(typed.event);
    }
  }
  for await (const snapshot of api.follow(runId, call)) seen.push(snapshot.status);
  for await (const line of api.followOutput(runId, followOutput)) seen.push(String(line));
  await api.wake(runId, { ...wake, ...call });
  await api.cancel(runId, call);
  return seen;
}

// --- The option bags a TOOL's client takes, named by a helper ----------------

export const toolSide = {
  start: {
    key: "session",
    dedupeKey: "audit:u1",
    label: "nightly",
    notify: true,
  } satisfies StartOptions,
  findByKey: {
    since: Date.now(),
    statuses: ["completed"],
    limit: 5,
    withOutput: true,
  } satisfies FindByKeyOptions,
  find: { limit: 3 } satisfies FindOptions,
  stream: { namespace: "progress", startIndex: 0 } satisfies StreamOptions,
};

export async function config(): Promise<ClientConfigResponse> {
  return ClientConfigResponseSchema.parse(await client.config());
}
