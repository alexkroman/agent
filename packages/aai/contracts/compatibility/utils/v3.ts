// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 3.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 3 adds `responseErrorMessage` to epoch 2's surface and takes
 * nothing away, which is why `../utils/v2.ts` (and `v1.ts` beneath it) are
 * retained rather than dropped — this file only has to demonstrate what is new.
 */

import { responseErrorMessage } from "../../../sdk/utils.ts";

/**
 * The shape every caller of an agent's own HTTP API writes: a failed response
 * carries the agent's sentence, and that sentence is what the caller reports.
 */
export async function startRun(url: string, input: unknown): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: "digest", input }),
  });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return ((await res.json()) as { runId: string }).runId;
}

/** `label` is optional, and names the surface only when we fall back to a status. */
export async function describeFailure(res: Response): Promise<string> {
  return await responseErrorMessage(res, "Workflow API");
}
