// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 2.
 *
 * Epoch 3 changed nothing a step is written against. What moved is `ToolDef`,
 * which gained an optional `messages` field — the agent's speech around a tool
 * call — and `stepDelegate` names the subagent/tool vocabulary, so this
 * capability's report moved with it.
 *
 * The promise is that an epoch-2 step body still compiles: the environment
 * read (`stepEnv`/`requireStepEnv`), the bounded fan-out that settles each
 * item beside its input (`mapSettled`/`partitionSettled`, over the window
 * `mapConcurrent` established), the progress line a page renders
 * (`stepReport`), and the retry vocabulary a transient status is classified
 * with.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * already names all forty-two of this one's exports, so this file is about the
 * transition rather than a roll-call. Its specifiers are RELATIVE, so it
 * proves epoch 2's surface compiles rather than the current build's.
 *
 * @module
 */

import type { Settled } from "../../../sdk/step-barrel.ts";
import {
  isTransientStatus,
  mapSettled,
  partitionSettled,
  requireStepEnv,
  retryAfter,
  stepReport,
} from "../../../sdk/step-barrel.ts";

/** One page of a batch, fetched with the window a step is allowed to open. */
export async function fetchPages(ids: readonly string[]): Promise<string[]> {
  const base = requireStepEnv("ORDERS_API_URL");
  const settled: Settled<string, string>[] = await mapSettled(ids, 4, async (id) => {
    const res = await fetch(`${base}/orders/${id}`);
    if (isTransientStatus(res.status)) {
      throw new Error(`retry after ${retryAfter(res.headers) ?? 0}s`);
    }
    return await res.text();
  });
  const { ok, failed } = partitionSettled(settled);
  await stepReport(`${ok.length} of ${ids.length} orders read`);
  if (failed[0] !== undefined) await stepReport(`first failure: ${failed[0].error}`);
  return ok.map((entry) => entry.value);
}
