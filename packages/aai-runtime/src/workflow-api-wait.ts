// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow API's SYNCHRONOUS mode: hold the request open until the run
 * settles.
 *
 * `POST /workflows/runs` answers 202 with a run id, which is the honest default
 * — a run is durable and deliberately not finished when the request returns.
 * That is exactly right for a page, which has `useWorkflowRun` to watch with,
 * and it is a poor fit for everything else that talks to an agent: a shell
 * script, a cron job, another service, a form whose only job is to show an
 * answer. Those want one request in and one result out, and without it each has
 * to write the same poll loop against `GET /runs/:id`.
 *
 * So both read paths take a `wait`: the request is answered when the run reaches
 * a terminal status, or when the budget runs out, whichever comes first.
 *
 * ## Giving up is an ANSWER, not a failure
 *
 * A budget that expires answers with the RUNNING snapshot and a 202 — never an
 * error, and never a cancel. The run is real, the caller holds its id, and the
 * only thing that ran out is this request; a 5xx would throw away the one thing
 * the caller cannot reconstruct. That is what makes the cap
 * (`MAX_WORKFLOW_WAIT_MS`) safe to enforce rather than a trap: waiting degrades
 * to the asynchronous behaviour that was already there.
 *
 * ## It polls, and the read is SHARED
 *
 * This loop used to justify its interval on the read being local — inside the
 * guest, next to the world the run lives in, for the life of one request a
 * caller is already holding open. On a deployed agent that is false: every read
 * is a `POST /:slug/workflow-journal`, and this is the fastest of three loops
 * that may be watching the same run in the same process. So it no longer reads
 * directly; it asks `workflow-run-reads.ts` for an observation no later than
 * {@link WORKFLOW_WAIT_POLL_MS} from now, which is one read shared with every
 * other watcher of that run.
 *
 * The interval stays the tightest of the three, and that is what the shared
 * reader honours: a synchronous call's whole value is that a fast run answers
 * fast, so the stream's slower watchers ride this pace rather than setting it.
 */

import { clampWorkflowWait } from "@alexkroman1/aai/internal";
import { isTerminal, type WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { type RunReader, watchRun } from "./workflow-run-reads.ts";

/**
 * How often a waiting request re-reads the run.
 *
 * Below what a person perceives as a delay on a fast workflow. Quicker than
 * `RUN_EVENT_POLL_MS` on purpose: the stream is watching something the reader
 * will see anyway, while this interval is added latency on every synchronous
 * call that finishes. It is a DEADLINE rather than a period — the shared reader
 * may answer sooner because somebody else asked sooner, and never later.
 */
export const WORKFLOW_WAIT_POLL_MS = 250;

/**
 * What a waiting request needs to know about the caller still being there.
 *
 * A narrow type rather than `http.ServerResponse`, matching `EventSink` next
 * door and for the same reason: a spec drives this with an object literal, and
 * "the caller went away" is the whole of what the loop asks about.
 *
 * **It is the RESPONSE, not the request, and that is not interchangeable.** An
 * `IncomingMessage` is `destroyed` as soon as its body has been fully read —
 * which on a `POST` has already happened by the time the wait starts — so a
 * loop watching the request would see every synchronous start as an abandoned
 * one and answer on its first read. Nothing about that failure is visible: the
 * status is a legal 202 and the run really is still going.
 */
export type CallerLink = {
  /** True once the response's connection is gone. */
  destroyed: boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
};

/**
 * Read `runId` until it settles, the budget expires, or the CALLER GOES AWAY.
 *
 * That last one matters more than it looks: a page navigating away mid-wait
 * would otherwise leave this reading a database for a response nobody will
 * receive, once per abandoned submit.
 *
 * Resolves whatever the last read saw — terminal or not, `undefined` for an id
 * the agent does not know. The caller decides what each of those means, because
 * they mean different things on a `POST` (202, still running) and a `GET`.
 *
 * @internal
 */
export async function waitForRun(
  reader: RunReader,
  runId: string,
  waitMs: number,
  link: CallerLink,
  options: { now?: () => number; pollMs?: number } = {},
): Promise<WorkflowRunSnapshot | undefined> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? WORKFLOW_WAIT_POLL_MS;
  const deadline = now() + clampWorkflowWait(waitMs);

  let gone = link.destroyed;
  const onClose = () => {
    gone = true;
  };
  link.once("close", onClose);
  const watch = watchRun(reader, runId);
  // ZERO for the first look: a caller holding a request open must not wait out
  // an interval to hear about a run that has already finished. The shared
  // reader takes that read on this call rather than on a timer.
  let within = 0;
  try {
    for (;;) {
      const run = await watch.next(within);
      if (isTerminal(run) || gone) return run;
      // A run the agent does not know will not start being known, so there is
      // nothing to wait for — but only AFTER a read, so a caller polling an id
      // from a previous deploy gets its answer immediately rather than at the
      // deadline.
      if (!run) return;
      const remaining = deadline - now();
      if (remaining <= 0) return run;
      // TRIMMED to what is left, so a 100 ms budget answers in 100 ms rather
      // than at the next full interval — the shared reader schedules its tick
      // at the earliest deadline it holds, which is what makes that reachable.
      within = Math.min(pollMs, remaining);
    }
  } finally {
    watch.close();
    link.off("close", onClose);
  }
}
