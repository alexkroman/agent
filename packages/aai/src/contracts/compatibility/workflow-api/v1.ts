// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 1.
 *
 * Epoch 2 gave every request-response call on {@link WorkflowApi} an optional
 * caller `signal` — `list`, `start`, `startAndWait`, `get`, `find`, `recent`,
 * `cancel`, `wake` and `uploadInfo` — which the streaming calls (`watch`,
 * `streamOutput`, `follow`, `download`) already took. Before it, a page that
 * unmounted could not cancel a pending request at all, including a
 * `startAndWait` the agent was holding open for up to its whole wait budget;
 * `timeoutMs` bounded the request and nothing let the CALLER end it sooner.
 *
 * Every addition is an optional member of an options bag, or a new optional
 * trailing bag, so a caller written against epoch 1 compiles unchanged — which
 * is what this file proves. The front half is that caller: every call below is
 * spelled exactly as epoch 1 allowed, with no `signal` anywhere. The one
 * implementer-facing consequence is covered too: a hand-written `WorkflowApi`
 * stub whose methods take FEWER parameters than the type still satisfies it,
 * which is how every test double of this client is written.
 *
 * If a later epoch changes what an epoch-1 call may pass, this file reddens,
 * which is the signal to DROP the epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 29 exports**, because a fixture that names
 * one signature freezes one signature (`api-contracts-gate.test.ts`). The back
 * half is that roll-call.
 *
 * **Its specifiers are RELATIVE**, so it proves epoch 1 compiles against the
 * current SOURCE rather than against whatever the package's `exports` map
 * resolves to.
 *
 * @module
 */

import type {
  AgentClient,
  AnyWorkflowDef,
  ClientConfigResponse,
  EventStreamFrame,
  FindOptions,
  StartOptions,
  StreamOptions,
  TerminalWorkflowRun,
  UploadBody,
  UploadOptions,
  UploadParallelOption,
  UploadPartsOptions,
  UploadProgress,
  UploadRef,
  WakeUpOptions,
  WorkflowApi,
  WorkflowApiClientOptions,
  WorkflowBody,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowRunBase,
  WorkflowRunOf,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSummary,
} from "../../../sdk/workflow-api-barrel.ts";
import {
  ClientConfigResponseSchema,
  createAgentClient,
  createWorkflowApiClient,
  isTerminal,
  readEventStream,
} from "../../../sdk/workflow-api-barrel.ts";

// ─── A caller, as epoch 1 wrote one ──────────────────────────────────────────

const options: WorkflowApiClientOptions = {
  baseUrl: "https://agents.example/digest-desk",
  token: "t",
  timeoutMs: 20_000,
};
const api: WorkflowApi = createWorkflowApiClient(options);

/** Every request-response call, spelled without a `signal`. */
export async function drive(file: UploadBody): Promise<string | undefined> {
  const declared: WorkflowSummary[] = await api.list();
  if (declared.length === 0) return;

  const progress = (p: UploadProgress): void => void p;
  const parallel: UploadParallelOption = true;
  const uploadOptions: UploadOptions = { onProgress: progress, parallel };
  const ref: UploadRef = await api.upload(file, uploadOptions);

  const runId = await api.start("digest", { upload: ref.id }, { key: "user-1" });
  const run: WorkflowRunSnapshot | undefined = await api.get(runId, { wait: 5000 });
  const settled: WorkflowRunSnapshot = await api.startAndWait("digest", {}, { wait: 30_000 });
  const mine: WorkflowRunSnapshot[] = await api.find("digest", "user-1", { limit: 5 });
  const latest: WorkflowRunSnapshot[] = await api.recent("digest", { limit: 5 });
  const woken: number = await api.wake(runId, { correlationIds: ["approval"] });
  const cancelled: boolean = await api.cancel(runId);
  const info = await api.uploadInfo(ref.id);

  if (run && isTerminal(run)) {
    const done: TerminalWorkflowRun = run;
    const status: WorkflowRunStatus = done.status;
    return status;
  }
  return [settled.status, mine.length, latest.length, woken, cancelled, info.complete].join();
}

/** The streaming calls, which took a signal already at epoch 1. */
export async function tail(runId: string, signal: AbortSignal): Promise<number> {
  let seen = 0;
  for await (const snapshot of api.follow(runId, { signal })) {
    const base: WorkflowRunBase = snapshot;
    seen += base.runId === runId ? 1 : 0;
  }
  const res = await api.watch(runId, signal);
  if (res.body) {
    for await (const frame of readEventStream(res.body, signal)) {
      const read: EventStreamFrame = frame;
      if (read.event === "done") break;
    }
  }
  await api.download("upl_1", { signal });
  return seen;
}

/**
 * A hand-written stub of the whole client, the way a test double is written:
 * methods that take FEWER parameters than the type. Epoch 2's new trailing
 * bags must not oblige a stub to declare them.
 */
const stored = { id: "upl_1", name: "a.wav", type: "audio/wav", size: 0, complete: true };

export const stub: WorkflowApi = {
  list: async () => [],
  upload: async () => ({ ...stored, url: "https://agents.example/uploads/upl_1" }),
  start: async () => "wrun_1",
  startAndWait: async () => ({
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "pending",
  }),
  get: async () => undefined,
  find: async () => [],
  recent: async () => [],
  cancel: async () => false,
  watch: async () => new Response(null),
  streamOutput: async () => new Response(null),
  follow: () => ({
    async *[Symbol.asyncIterator]() {
      // A run with no snapshots: the stub yields nothing.
    },
  }),
  followOutput: () => ({
    async *[Symbol.asyncIterator]() {
      // A run with no output.
    },
  }),
  wake: async () => 0,
  uploadStream: async () => ({ ...stored, url: "https://agents.example/uploads/upl_1" }),
  uploadInfo: async () => stored,
  download: async () => new Blob([]),
};

// ─── The roll-call ───────────────────────────────────────────────────────────

const digest = {
  run: async () => ({ summary: "" }),
} satisfies AnyWorkflowDef<{ summary: string }>;

export type Epoch1Types = {
  agentClient: AgentClient;
  anyWorkflowDef: AnyWorkflowDef;
  clientConfigResponse: ClientConfigResponse;
  eventStreamFrame: EventStreamFrame;
  findOptions: FindOptions;
  startOptions: StartOptions;
  streamOptions: StreamOptions;
  terminalWorkflowRun: TerminalWorkflowRun;
  uploadBody: UploadBody;
  uploadOptions: UploadOptions;
  uploadParallelOption: UploadParallelOption;
  uploadPartsOptions: UploadPartsOptions;
  uploadProgress: UploadProgress;
  uploadRef: UploadRef;
  wakeUpOptions: WakeUpOptions;
  workflowApi: WorkflowApi;
  workflowApiClientOptions: WorkflowApiClientOptions;
  workflowBody: WorkflowBody;
  workflowInputOf: WorkflowInputOf<typeof digest>;
  workflowOutputOf: WorkflowOutputOf<typeof digest>;
  workflowRunBase: WorkflowRunBase;
  workflowRunOf: WorkflowRunOf<typeof digest>;
  workflowRunSnapshot: WorkflowRunSnapshot;
  workflowRunStatus: WorkflowRunStatus;
  workflowSummary: WorkflowSummary;
};

/** The schema a client validates `/client-config` against, owned here too. */
export function parseClientConfig(body: unknown): ClientConfigResponse {
  return ClientConfigResponseSchema.parse(body);
}

export const epoch1Values = [
  createAgentClient,
  createWorkflowApiClient,
  isTerminal,
  readEventStream,
] as const;
