// Copyright 2026 the AAI authors. MIT license.
/**
 * The tenancy property's VOCABULARY, and the one harness surface every caller
 * imports.
 *
 * An {@link Op} is one store call addressed to one tenant; an {@link Answer} is
 * what it answered; a {@link TenantDump} is one tenant's entire state as the
 * audit compares it. The other three halves of the harness are re-exported here
 * so nothing has to know which file a symbol lives in:
 *
 * - `_tenancy-grammar-harness.ts` — the colliding pools, the weighted shapes,
 *   the prologue. What a program IS.
 * - `_tenancy-census-harness.ts` — the collision states a program REACHED, and
 *   the floors that make the property non-vacuous.
 * - `_tenancy-world-harness.ts` / `_tenancy-state-harness.ts` — the
 *   tenant-partitioned reference the arms are compared against.
 */

import type { Slug } from "./_tenancy-grammar-harness.ts";

export {
  type Census,
  emptyCensus,
  NEIGHBOUR,
  noteAnswer,
  noteOp,
} from "./_tenancy-census-harness.ts";
export { label, PROLOGUE, programArb, SLUGS, type Slug } from "./_tenancy-grammar-harness.ts";

/** One store call, addressed to one tenant. */
export type Op =
  | {
      t: "createRun";
      slug: Slug;
      runId: string;
      workflow: string;
      input: string | undefined;
      createdAt: number;
    }
  | { t: "getRun"; slug: Slug; runId: string }
  | { t: "listRuns"; slug: Slug; workflow: string; limit: number }
  | {
      t: "setStatus";
      slug: Slug;
      runId: string;
      status: string;
      result: { output?: string | undefined; error?: string | undefined } | undefined;
      expect: readonly string[] | undefined;
    }
  | {
      t: "appendStep";
      slug: Slug;
      runId: string;
      key: string;
      status: string;
      output: string | undefined;
      finishedAt: number;
    }
  | { t: "readSteps"; slug: Slug; runId: string }
  | { t: "claimAttempt"; slug: Slug; runId: string; key: string; holder: string }
  | {
      t: "claimSleep";
      slug: Slug;
      runId: string;
      key: string;
      wakeAt: number;
      correlationId: string | undefined;
      kind: string;
    }
  | {
      t: "wakeSleeps";
      slug: Slug;
      runId: string;
      now: number;
      correlationIds: readonly string[] | undefined;
    }
  | { t: "claimHook"; slug: Slug; runId: string; key: string; token: string }
  | { t: "deliverHook"; slug: Slug; token: string; payload: string | undefined }
  | { t: "closeHook"; slug: Slug; runId: string; key: string }
  | { t: "claimUpload"; slug: Slug; id: string; name: string; expected: number | undefined }
  | { t: "insertUpload"; slug: Slug; id: string; name: string; size: number }
  | { t: "updateUpload"; slug: Slug; id: string; size: number; complete: boolean }
  | { t: "finishUpload"; slug: Slug; id: string; size: number }
  | { t: "readUpload"; slug: Slug; id: string }
  | { t: "commitSlots"; slug: Slug; sessionId: string; values: Record<string, string> }
  | { t: "loadSlots"; slug: Slug; sessionId: string }
  | {
      t: "appendEvents";
      slug: Slug;
      sessionId: string;
      events: readonly { index: number; event: string }[];
    }
  | { t: "readEvents"; slug: Slug; sessionId: string; startIndex: number; limit: number }
  | { t: "nextEventIndex"; slug: Slug; sessionId: string }
  | { t: "discardSession"; slug: Slug; sessionId: string };

/**
 * What one call answered, in a shape both arms can produce.
 *
 * A refusal is a VALUE rather than a thrown error because it is observable and
 * therefore a leak surface in its own right: `claimHook`'s refusal names the
 * holding run, so an arm that answered a NEIGHBOUR's run id there would be
 * leaking through an error message. Comparing the refusals is what catches it.
 */
export type Answer =
  | { ok: unknown }
  | { refused: "run-taken" }
  | { refused: "upload-taken" }
  | { refused: "hook-token"; holder: string | undefined };

/** One tenant's ENTIRE state, canonically ordered, as the audit compares it. */
export type TenantDump = {
  runs: {
    runId: string;
    workflow: string;
    status: string;
    createdAt: number;
    input: string | undefined;
    output: string | undefined;
    error: string | undefined;
  }[];
  steps: {
    runId: string;
    key: string;
    status: string;
    output: string | undefined;
    attempts: number;
    finishedAt: number;
  }[];
  attempts: { runId: string; key: string; n: number }[];
  sleeps: {
    runId: string;
    key: string;
    wakeAt: number;
    woken: boolean;
    correlationId: string | undefined;
    kind: string;
  }[];
  hooks: {
    runId: string;
    key: string;
    token: string;
    delivered: boolean;
    payload: string | undefined;
    closed: boolean;
  }[];
  uploads: {
    id: string;
    name: string;
    type: string;
    size: number;
    complete: boolean;
    expected: number | undefined;
    parts: { at: number; bytes: number }[];
  }[];
  slots: { sessionId: string; slot: string; value: string }[];
  events: { sessionId: string; index: number; event: string }[];
};

/** An empty tenant, which is what both arms build a dump on top of. */
export const emptyDump = (): TenantDump => ({
  runs: [],
  steps: [],
  attempts: [],
  sleeps: [],
  hooks: [],
  uploads: [],
  slots: [],
  events: [],
});

/**
 * One canonical row order, applied by BOTH arms rather than by each.
 *
 * Deliberately not an `order by` in the platform arm's audit queries: Postgres
 * orders `text` by the database's COLLATION, which does not agree with
 * JavaScript's code-unit comparison on the punctuation these ids carry
 * (`k!0`, `wf_r0`). Two correct arms would then disagree on row order and the
 * property would report a leak that is really a locale.
 */
export function sortTenantDump(dump: TenantDump): TenantDump {
  const cmp = (a: string | number, b: string | number): number => {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  };
  return {
    runs: [...dump.runs].sort((x, y) => cmp(x.runId, y.runId)),
    steps: [...dump.steps].sort((x, y) => cmp(x.runId, y.runId) || cmp(x.key, y.key)),
    attempts: [...dump.attempts].sort((x, y) => cmp(x.runId, y.runId) || cmp(x.key, y.key)),
    sleeps: [...dump.sleeps].sort((x, y) => cmp(x.runId, y.runId) || cmp(x.key, y.key)),
    hooks: [...dump.hooks].sort((x, y) => cmp(x.runId, y.runId) || cmp(x.key, y.key)),
    uploads: [...dump.uploads].sort((x, y) => cmp(x.id, y.id)),
    slots: [...dump.slots].sort((x, y) => cmp(x.sessionId, y.sessionId) || cmp(x.slot, y.slot)),
    events: [...dump.events].sort((x, y) => cmp(x.sessionId, y.sessionId) || cmp(x.index, y.index)),
  };
}
