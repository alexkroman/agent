// Copyright 2026 the AAI authors. MIT license.
/**
 * The third {@link WorkflowKeyStore}: the correlation-key index over HTTP.
 *
 * `(workflow, key) -> runId` is the only pointer from a caller to the durable run
 * they started, and a DEPLOYED agent had nowhere durable to keep it. The other
 * two backends are a `Map` and a table in the agent's own `DATABASE_URL`; the
 * platform provisions no tenant database, so `resolveKeyStore` fell to the `Map`
 * — inside a sandbox that self-exits after `AGENT_IDLE_EXIT_MS`.
 *
 * This is the journal's bug one table over, and it survived the fix for it. Since
 * `workflow-journal-platform.ts` the RUN outlives its sandbox; the pointer did
 * not, so `find(workflow, "+14155550123")` answered `[]` on the caller's next
 * call and the agent started a second run for somebody it had already served.
 * Nothing could report it: an empty index and a first-time caller are the same
 * answer, and the boot line said `keyStore: "memory"` on every deployment with
 * nobody reading it.
 *
 * ## A third implementation, not a new design
 *
 * Both methods are one `POST` to `/:slug/workflow-keys`, and the platform runs
 * the SAME two statements the self-hosted store does
 * (`aai-server/platform-workflow-keys.ts` mirrors `workflow-keys.ts`, with the
 * slug added to the key). The three backends agreeing is what makes the memory
 * one a valid double for the other two — `workflow-keys-conformance.ts` is the
 * shared case list — so nothing here may "helpfully" differ. Two agreements are
 * worth naming because both are silent when broken:
 *
 * - **`record` is idempotent and FIRST WRITE WINS.** A retried call after a lost
 *   connection must neither fail nor list the run twice nor move it, which is what
 *   `on conflict (slug, run_id) do nothing` buys on the far side. So this method
 *   sends the same body again and reads no answer: there is nothing to compare and
 *   nothing to fall back to.
 * - **`lookup` answers NEWEST FIRST, and the platform's `order by` is what makes
 *   that true.** This side must not re-sort — the run ids come back in the order
 *   the index walked them, and a client-side sort would be a second ordering rule
 *   able to disagree with the one the other two backends implement.
 *
 * ## `createdAt` crosses the wire
 *
 * `WorkflowKeyStore.record` takes no timestamp, so this client stamps one — the
 * same decision `wakeSleeps` makes about `now`. The ordering the index promises is
 * "the order they were started" and the ENGINE is what started them, so letting
 * the database's `now()` decide would put a second clock in the one value that
 * ordering rests on, and would disagree with `workflow_runs.created_at`, which the
 * journal already takes from here.
 *
 * ## What a failure does
 *
 * Every method propagates, and the caller above already has a policy for each.
 * `WorkflowClient.start` CATCHES a failed `record` and warns — the run is already
 * created, so throwing would tell the caller nothing happened while the work
 * proceeds unreachably — and a failed `lookup` fails the `find` that asked, which
 * is right: an empty array would be indistinguishable from a caller with no prior
 * run, which is the exact confusion this whole file exists to end.
 *
 * **A 501 is not special, deliberately.** The platform answers it when the
 * deployment has no platform database, and this backend does not downgrade to
 * memory on reading one: the backend is chosen ONCE, from whether the boot env
 * named a platform, so there is nothing per request to re-decide. Silently
 * becoming memory is the failure this file exists to end.
 *
 * @internal
 */

import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformResult } from "./platform-rpc.ts";
import type { WorkflowKeyStore } from "./workflow-keys.ts";

/**
 * How long one index call may take.
 *
 * One indexed read or one insert on the platform's database, over the platform's
 * own network, so this bounds a hung socket rather than real work. Shorter than
 * the journal's 15s and for a reason of its own: both callers are on a caller's
 * TURN — a tool calling `start` with a key, or `find` before it can answer — where
 * a journal call is made by a delivery nobody is waiting on. Five seconds is
 * already past anything an agent can say to fill; and a `record` that times out
 * costs a later `find` rather than the run, because `start` treats it as a warning.
 */
const KEYS_TIMEOUT_MS = 5000;

/** One call to the platform's key-index route. */
async function call(
  opts: PlatformEndpoint,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return await platformResult(opts, {
    route: PLATFORM_ROUTES.workflowKeys,
    label: `workflow-keys ${method}`,
    timeoutMs: KEYS_TIMEOUT_MS,
    body: JSON.stringify({ method, ...body }),
    // No `errorFor`: neither method has a typed refusal to preserve. `record` is
    // idempotent and `lookup` answers an empty page rather than refusing, so every
    // non-2xx really is the store being unreachable — which `platformPost` already
    // reports with its status, and which a retryable one already tags with
    // `PLATFORM_UNAVAILABLE_CODE`.
  });
}

/**
 * Build the platform-backed correlation-key index.
 *
 * @internal
 */
export function createPlatformKeyStore(opts: PlatformEndpoint): WorkflowKeyStore {
  return {
    async record(workflow: string, key: string, runId: string): Promise<void> {
      await call(opts, "record", { runId, workflow, key, createdAt: Date.now() });
    },

    async lookup(workflow: string, key: string, limit: number): Promise<string[]> {
      const rows = await call(opts, "lookup", { workflow, key, limit });
      // An answer that is not a list of run ids is DROPPED to empty rather than
      // thrown on, which is the one place this store is deliberately lax — and it
      // is the same judgement `listRuns` makes in the journal client: the caller
      // is a lookup, and the honest answer to "which runs belong to this caller"
      // when the reply cannot be read is "none I can name". A non-string entry
      // would otherwise reach `find` as `"undefined"` and cost a `getRun` round
      // trip that can only answer nothing.
      if (!Array.isArray(rows)) return [];
      return rows.filter((row): row is string => typeof row === "string");
    },
  };
}
