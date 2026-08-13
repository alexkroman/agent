// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 2.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 added the two client methods that reach a run which is already going:
 * `streamOutput`, the browser half of `getWritable()`, and `wake`, which ends a
 * pending `sleep()`. Everything epoch 1 could express still compiles (see
 * `./v1.tsx`, retained for that reason); this file covers only what epoch 2
 * added.
 */

import { createWorkflowApi, type WorkflowApi } from "../../../index.ts";

const api: WorkflowApi = createWorkflowApi({ baseUrl: "/" });

/**
 * The progress stream, raw like `watch` — because the first thing a caller
 * decides is whether the agent serves this at all: a deploy predating the route
 * answers 404, which is a normal path rather than a failure.
 */
export async function readProgress(runId: string): Promise<string[]> {
  const res: Response = await api.streamOutput(runId);
  if (!res.ok || res.body === null) return [];
  const lines: string[] = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) lines.push(value);
  }
  return lines;
}

/** Resuming from a known position, and reading a named stream. */
export async function resumeProgress(runId: string, from: number): Promise<number> {
  const tail: Response = await api.streamOutput(runId, { startIndex: -3 });
  const resumed: Response = await api.streamOutput(runId, {
    namespace: "progress",
    startIndex: from,
    signal: AbortSignal.timeout(60_000),
  });
  return Number(tail.ok) + Number(resumed.ok);
}

/** Ending the wait early. `0` is an answer — nothing was sleeping. */
export async function fileItNow(runId: string): Promise<string> {
  const woken: number = await api.wake(runId);
  return woken > 0 ? "filing now" : "already past its wait";
}
