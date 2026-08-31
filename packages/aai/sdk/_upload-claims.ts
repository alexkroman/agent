// Copyright 2026 the AAI authors. MIT license.
/**
 * Telling the agent which windows landed, in as few requests as it will accept.
 *
 * **The claim is what an upload spent its time on.** On the direct path the bytes go
 * to the platform and a body-less `PUT …/parts?offset=…&stored=1` tells the agent
 * which window arrived — a request carrying nothing that measured 1604-1969 ms
 * against a deployed agent, per PART, roughly half of a part's wall clock. It is
 * slow because of where it goes rather than what it carries: across the platform
 * and into the sandbox, where the guest then has to reach the record's home and the
 * bucket.
 *
 * Two things have been done about that, and this module is the FIRST: batching, so
 * the toll is paid per claim rather than per part (`UPLOAD_CLAIM_BATCH`). The
 * second is on the guest side, where one claim used to cost three round trips to
 * the record's home plus eight sequential rounds of bucket probes — see
 * `aai-runtime/_upload-store.ts`, `UPLOAD_PROBE_CONCURRENCY`, which carries the
 * measurement (5013 ms to 1203 ms on a harness at these latencies).
 *
 * Its own module because `workflow-upload-parts.ts` is at the file-length cap and
 * this is the seam that was already there — the fan-out owns the BYTES and this owns
 * the receipts. `UPLOAD_CLAIM_BATCH` carries the measurement and the cap; the route
 * that answers these requests is `host/workflow-api-uploads.ts`.
 */

import { withRetries } from "./_upload-retry.ts";
import { createCoalescingRunner } from "./coalescing-runner.ts";

/**
 * What a landed window is handed to, and what closes the upload out.
 *
 * See {@link createClaimer}.
 */
export type Claimer = {
  /** Note that this window is in the bucket and the agent has not been told. */
  landed(offset: number): void;
  /**
   * Wait for every landed window to be recorded, and re-throw the first claim that
   * failed.
   *
   * Must be awaited before the closing `/info` read: that read is what decides the
   * upload is complete, and a claim still in flight would make it answer about a
   * record it is about to change.
   */
  drain(): Promise<void>;
  /**
   * The first claim that failed, or `undefined`.
   *
   * For the fan-out's own error path: a failing claim ABORTS every window in
   * flight, so what `mapConcurrent` then reports is that abort rather than its
   * cause, and raising it would name the symptom.
   */
  failure(): unknown;
};

/**
 * Tell the agent which windows landed, in as few requests as it will accept.
 *
 * **The claim is what an upload spent its time on.** It carries no bytes and
 * measured 1604-1969 ms against a deployed agent — roughly half of a part's wall
 * clock, paid per PART — because it crosses the platform into the sandbox and then
 * costs the guest a read of the record and a probe of the bucket for every window
 * it names. So it is no longer on the critical path of a fan-out slot: a part
 * hands its offset here and the slot goes straight to the next window's bytes,
 * which is what puts the width back into the BYTES it was meant to be about.
 *
 * `createCoalescingRunner` is exactly this shape and the reason it is a primitive:
 * at most one claim in flight, every window that lands during it coalesces into ONE
 * trailing claim, and the run reads the pending set when it runs rather than
 * carrying a payload. So the batch sizes itself — the first claim names one window,
 * and each one after it names however many landed while the last was in the air.
 *
 * ## A failed claim fails the UPLOAD, and it has to be told to
 *
 * The runner's own contract is that a rejection reaches only the callers awaiting
 * that run and never wedges it, so a fire-and-forget trigger must attach a `catch`
 * — and here that catch is load-bearing rather than hygiene. Every window whose
 * claim never landed is a stored object the agent has no record of, and the closing
 * `assertRecorded` would report it as an upload the agent acknowledged and did not
 * write. So the first failure is KEPT, `onFail` aborts the windows still on the
 * wire (bytes nobody will read, on a link somebody is waiting on), and `drain`
 * re-throws it.
 */
export function createClaimer(opts: {
  /** `…/uploads/<id>`, the agent's own route for this upload. */
  uploads: string;
  /** Auth headers, if the API is closed. */
  headers: Record<string, string>;
  /** How many offsets one request may name — the AGENT's number, never assumed. */
  batch: number;
  /** The per-request retry budget the rest of this path runs on. */
  attempts: number;
  /** The fan-out's combined signal. */
  signal: AbortSignal;
  /** How the caller turns a failed response into an error. */
  fail: (res: Response) => Promise<Error>;
  /** Stop the windows still in flight — see the doc above. */
  onFail: (err: unknown) => void;
}): Claimer {
  const pending: number[] = [];
  let failure: unknown;

  const runner = createCoalescingRunner(async (): Promise<void> => {
    // A loop rather than one request, because the pending set can exceed the batch:
    // the coalesced trailing run is the only one that will be started for everything
    // that landed during its predecessor, so leaving a remainder behind would strand
    // it until some later window happens to trigger another run.
    while (pending.length > 0 && failure === undefined) {
      const sending = pending.splice(0, opts.batch);
      const query = sending.map((at) => `offset=${at}`).join("&");
      const { res } = await withRetries(
        () =>
          fetch(`${opts.uploads}/parts?${query}&stored=1`, {
            method: "PUT",
            headers: opts.headers,
            signal: opts.signal,
          }),
        { attempts: opts.attempts, signal: opts.signal },
      );
      if (!res.ok) throw await opts.fail(res);
    }
  });

  const note = (err: unknown): void => {
    // The FIRST failure, because the ones after it are usually the abort this one
    // caused, and a caller reading "aborted" learns nothing about why.
    failure ??= err;
    opts.onFail(err);
  };

  return {
    landed(offset: number): void {
      pending.push(offset);
      void runner.trigger().catch(note);
    },
    failure(): unknown {
      return failure;
    },
    async drain(): Promise<void> {
      // `trigger()` promises a run that reflects state as of this call or later, so
      // awaiting one here settles any claim already in flight AND covers whatever is
      // still pending — with no special case for "nothing left", which runs the loop
      // zero times.
      await runner.trigger().catch(note);
      if (failure !== undefined) throw failure;
    },
  };
}
