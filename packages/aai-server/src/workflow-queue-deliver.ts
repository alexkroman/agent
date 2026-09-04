// Copyright 2026 the AAI authors. MIT license.
/**
 * How one claimed queue message reaches its tenant's guest.
 *
 * `workflow-queue-sweep.ts` decides WHEN and what to do with the answer; this is
 * the `DeliverMessage` it takes as a seam. Separate modules because the two fail
 * for unrelated reasons and are tested against unrelated things: the sweep's
 * whole subject is claim/ack/backoff policy, and its specs never stand up a
 * guest, while this one's whole subject is the hop — brokering a sandbox, minting
 * a bearer, and reading the DevKit's three-way answer off an HTTP response.
 *
 * ## Brokering is what makes a durable run durable
 *
 * The usual state when a message comes due is NO SANDBOX AT ALL: an agent guest
 * self-exits on idle, and a run that sleeps an hour outlives many of them. So
 * this goes through `brokerSessionUrl`, the platform's one routing point, which
 * boots one if it has to — the same thing `workflow-webhook-handler.ts` does for
 * a webhook parked days ago, and for the same reason. The run's state is in
 * storage, not in the guest's memory, so a fresh guest resumes it.
 *
 * ## The answer has THREE shapes, and the third is `sleep()`
 *
 * This is the DevKit's queue↔executor contract, reproduced from
 * `executeMessageOverHttp` in `@workflow/world-postgres`:
 *
 * - non-2xx → THROW. The sweep backs off and eventually abandons.
 * - 2xx whose body parses to `{"timeoutSeconds": n}` → the run parked itself.
 *   Reschedule, do not ack.
 * - any other 2xx → completed.
 *
 * A body that is not JSON, or JSON without a finite `timeoutSeconds`, is
 * `completed` — the DevKit's own reader does the same (a bare `catch {}` around
 * the parse), and guessing otherwise would strand a healthy run.
 *
 * ## Concurrent deliveries to ONE slug broker once
 *
 * `claimDue` is `distinct on (slug, runId)`, so one pass routinely holds several
 * messages for the same agent — one per active run — and the sweep fans them out
 * `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` at a time. Every one of them asked the
 * broker for the same slug independently, which is worst exactly where it costs
 * most: on a COLD slug the broker is the seconds-long part of a delivery, so the
 * concurrent deliveries overlap almost entirely and each pays a full routing
 * round trip for an answer another is already fetching.
 *
 * {@link createSingleFlight} collapses that window and RETAINS NOTHING, which is
 * what makes it the right primitive rather than a cache: a brokered origin is
 * only good while that sandbox is up, so a delivery starting after the previous
 * one settled must route again. Nothing about the fan-out changes — the same
 * number of deliveries are in flight, they just share one answer to "where is
 * this agent".
 */

import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { createSingleFlight } from "./_memo.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import { GuestUnreachableError } from "./workflow-queue-failure.ts";
import { envelopeBody, parseEnvelope, type QueuedMessage } from "./workflow-queue-store.ts";
import type { DeliverMessage } from "./workflow-queue-sweep.ts";

const log = createLogger("workflow.queue.deliver");

/**
 * How long a guest has to answer one delivery.
 *
 * A step runs tenant code — an LLM call, an HTTP request, a database write — so
 * this is a ceiling on one step rather than a round-trip budget. 60s against the
 * webhook proxy's 30s because nothing is holding a caller's connection open
 * here: the only cost of waiting is one of this replica's delivery slots.
 *
 * A step that legitimately runs longer must not be forced through this: it
 * answers `{"timeoutSeconds"}` and parks, which is what `sleep()` is for.
 */
export const QUEUE_DELIVERY_TIMEOUT_MS = 60_000;

export type QueueDelivererOptions = {
  /** Reads the deployed version the running guest's token was derived from. */
  store: { getAgentVersion(slug: string): Promise<number | null> };
  /** What `brokerSessionUrl` needs to boot a sandbox. */
  broker: ResolveSandboxOpts;
  /** Injectable so a spec can assert what crossed without a sandbox. */
  fetchFn?: typeof fetch | undefined;
};

/**
 * The `{"timeoutSeconds": n}` a parked run answers with, or undefined.
 *
 * **Deliberately stricter than the DevKit's own reader**, which does
 * `Number(body.timeoutSeconds)` and so treats `null`, `""`, `true` and `[]` as
 * parks of 0 and 1 seconds — `Number(null)` is `0`, and `0` is a finite
 * non-negative number. None of those is a shape the DevKit ever emits (it writes
 * the field only when parking, always as a number), so requiring `typeof
 * "number"` cannot disagree with it about any real answer.
 *
 * The asymmetry is which way to be wrong on a body neither side produces. Read as
 * COMPLETED, one run is stranded. Read as a park of ZERO, the message comes back
 * immediately, replays, and answers the same thing — a redelivery loop that
 * spends a sandbox and a step's provider budget every second until the retry
 * budget is not even consulted, because a park is not a failure. So the
 * ambiguous body is completed.
 *
 * `Number.isFinite` still earns its place: it rejects the infinities and `NaN`,
 * either of which would reach the store as an interval Postgres cannot compute.
 */
function parkedFor(text: string): number | undefined {
  // `safeJsonParse` rather than a local try/catch: the overwhelmingly common 2xx
  // body is not JSON at all, and `undefined` is unambiguous because JSON cannot
  // encode it.
  const body = safeJsonParse(text);
  if (!isRecord(body)) return undefined;
  const seconds = body.timeoutSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  // A negative is not a sleep. The store clamps at zero anyway; a negative here
  // more likely means the field means something other than what we think.
  return seconds >= 0 ? seconds : undefined;
}

/**
 * Build the deliverer the sweep runs.
 *
 * @internal
 */
export function createQueueDeliverer(opts: QueueDelivererOptions): DeliverMessage {
  const fetchFn = opts.fetchFn ?? fetch;
  // Per SLUG, and only for as long as a routing call is actually running — see
  // the module doc. A rejection is shared too, which is correct: every joiner
  // would have got the same refusal, and each still settles its own message.
  const routing = createSingleFlight<{ guestOrigin: string; version: number }>();
  return async (message: QueuedMessage) => {
    const { slug } = message;
    const { guestOrigin, version } = await routing.run(slug, async () => {
      const brokered = await brokerSessionUrl(slug, opts.broker);
      if (!brokered.ok) {
        // Both cases THROW, and neither is silently dropped. A 404 means the slug
        // has no agent — normally impossible, because the queue row's FK cascades
        // on delete, so this is a delete/redeploy race — and a 503 means the boot
        // is still in flight, which the next tick joins. A "drop it now" outcome
        // would turn that race into a lost run.
        //
        // UNREACHABLE, because no request has been sent: whatever is wrong is
        // wrong with the fleet and not with this message, so it spends the
        // patient budget rather than the five attempts a refusing guest gets.
        // The 503 arm is the whole reason that distinction exists — see
        // `workflow-queue-failure.ts`.
        throw new GuestUnreachableError(`broker refused ${slug}: HTTP ${brokered.status}`);
      }
      // INSIDE the flight with the broker, because the two answer one question
      // together: the version is what the guest's bearer is derived from, and a
      // version read beside a DIFFERENT broker's origin is a token for another
      // sandbox.
      const deployed = await opts.store.getAgentVersion(slug);
      // Also UNREACHABLE: without a version there is no bearer to derive, so
      // nothing was asked. A deploy in flight is the ordinary cause.
      if (deployed === null) throw new GuestUnreachableError(`no deployed version for ${slug}`);
      return { guestOrigin: brokered.guestOrigin, version: deployed };
    });
    // Unwraps the QUEUE's envelope, not the DevKit's message: `data` holds the
    // devalue bytes and nothing here parses them.
    const body = envelopeBody(parseEnvelope(message.payload));

    const res = await fetchFn(guestHttpUrl(guestOrigin, GUEST_ROUTES.workflowQueue), {
      method: "POST",
      headers: {
        // The CALLER's headers go FIRST, so every platform header below WINS a
        // key collision. This spread used to be last, which made the whole set
        // caller-controlled: `queue(name, msg, { headers })` is a tenant's own
        // call, `optionalHeaders` checks only that the VALUES are strings, and
        // `enqueue` stores them verbatim. An `authorization` of the tenant's
        // choosing replaced the bearer below, the guest answered 401, the sweep
        // burned all five attempts, and nothing in the log named the payload; an
        // `x-vqs-queue-name` re-pointed the message at another entrypoint.
        //
        // No key allow-list, deliberately — a tenant may send any header it
        // likes to its own guest. It may not send OURS.
        ...message.headers,
        // The bearer the guest's manage surface checks — an HMAC over this
        // sandbox's fleet-wide name, which a direct dialer cannot forge.
        authorization: `Bearer ${guestTokenFor(agentSandboxName(slug, version))}`,
        "content-type": "application/json",
        // The queue↔executor contract. `x-vqs-queue-name` is what the guest
        // routes on; the other two are what the entrypoint reads.
        "x-vqs-queue-name": message.queueName,
        "x-vqs-message-id": message.id,
        "x-vqs-message-attempt": String(message.attempt),
      },
      // The devalue bytes, verbatim. The platform never looks INSIDE them — a
      // queue that parsed that payload would be a second implementation of
      // somebody else's serialization format. See `QueueEnvelope`.
      body,
      signal: AbortSignal.timeout(QUEUE_DELIVERY_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      // The BODY is in the error, truncated: a step that threw answers 500 with
      // the tenant's own message, and without it the only record of why a run
      // stalled is "HTTP 500".
      throw new Error(`guest answered HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const parked = parkedFor(text);
    if (parked !== undefined) {
      log.debug("run parked itself", { slug, id: message.id, seconds: parked });
      return { type: "reschedule", delaySeconds: parked };
    }
    return { type: "completed" };
  };
}
