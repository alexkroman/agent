// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow-api` epoch 1.
 *
 * Epoch 1 is the whole client: `createWorkflowApiClient` plus the ten calls it
 * returns, the three options it takes, and `WORKFLOW_API_PREFIX`. What this file
 * exercises is the shape a caller OUTSIDE an agent writes against — a script or
 * a cron job asking an agent to do durable work and reporting the answer — which
 * is exactly the audience the capability exists to promise something to.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Editing this file to silence a compile error defeats the mechanism:
 * the error IS the finding.
 */

import {
  createWorkflowApiClient,
  WORKFLOW_API_PREFIX,
  type WorkflowApi,
  type WorkflowApiClientOptions,
} from "../../../sdk/workflow-api-client.ts";
import { isTerminal } from "../../../sdk/workflow-run.ts";

/** Every option epoch 1 accepted, written out rather than inferred. */
const options: WorkflowApiClientOptions = {
  baseUrl: "https://agents.example/my-agent",
  token: "s3cret",
  timeoutMs: 30_000,
};

export const api: WorkflowApi = createWorkflowApiClient(options);

/** The minimal construction — a base URL and nothing else. */
export const anonymous: WorkflowApi = createWorkflowApiClient({
  baseUrl: "https://agents.example/my-agent/",
});

/** The prefix is published because both ends resolve it. */
export const prefix: string = WORKFLOW_API_PREFIX;

/** The asynchronous shape: start, keep the id, read it back later. */
export async function fireAndForget(): Promise<string> {
  const [declared] = await api.list();
  return await api.start(declared?.name ?? "digest", { topic: "ai" }, { key: "caller-1" });
}

/** The synchronous shape — one request in, one result out. */
export async function digest(topic: string): Promise<unknown> {
  const run = await api.startAndWait("digest", { topic }, { key: topic, wait: 30_000 });
  // A wait that ran out answers the RUNNING snapshot, so a caller checks rather
  // than assuming — which is why the status is a discriminated union.
  if (!isTerminal(run)) return { runId: run.runId, pending: true };
  return run.status === "completed" ? run.output : { failed: run.status };
}

/** Reading a run back, with and without holding the request open. */
export async function poll(runId: string): Promise<string | undefined> {
  const immediate = await api.get(runId);
  const waited = await api.get(runId, { wait: 5000 });
  return (waited ?? immediate)?.status;
}

/** Both list reads: the app's keyed one and the operator's keyless one. */
export async function history(workflow: string, key: string): Promise<number> {
  const mine = await api.find(workflow, key, { limit: 5 });
  const everyones = await api.recent(workflow, { limit: 20 });
  return mine.length + everyones.length;
}

/**
 * The run's own OUTPUT stream, which is a different question from its state:
 * `watch` reports status transitions, this reports what the run WROTE. Raw for
 * the same reason, and `startIndex` (negative counts back from the end) is what
 * a reader resuming from a known position passes.
 */
export async function progress(runId: string, signal: AbortSignal): Promise<boolean> {
  const whole: Response = await api.streamOutput(runId);
  const tail: Response = await api.streamOutput(runId, {
    namespace: "progress",
    startIndex: -3,
    signal,
  });
  return whole.ok && tail.ok;
}

/** Ending a `sleep()` early. `0` is an answer — nothing was sleeping. */
export async function sendItNow(runId: string): Promise<string> {
  const woken: number = await api.wake(runId);
  return woken > 0 ? "filing now" : "already past its wait";
}

/** Stopping a run: false means it had already finished, which is an answer. */
export async function stop(runId: string): Promise<boolean> {
  return await api.cancel(runId);
}

/**
 * Following a run as a stream.
 *
 * The RAW response, because what a caller decides first is whether the agent
 * serves the route at all — an older deploy answers 404 and the caller falls
 * back to {@link poll}, which is a normal path rather than an error.
 */
export async function follow(runId: string, signal: AbortSignal): Promise<boolean> {
  const stream: Response = await api.watch(runId, signal);
  return stream.ok;
}
