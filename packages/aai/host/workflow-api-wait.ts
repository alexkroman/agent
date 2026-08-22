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
 * ## It polls, and that is not the expensive kind of polling
 *
 * The same reasoning `workflow-api-events.ts` sets out for its SSE stream: the
 * cost of polling a run is the HTTP hop and, on the platform, the brokering in
 * front of it — not the read. This loop runs INSIDE the guest, next to the world
 * the run lives in, for the life of one request that a caller is already
 * holding open. It is deliberately faster than the event stream's interval,
 * because a synchronous call's whole value is that a fast run answers fast.
 */

import { sleep } from "../sdk/sleep.ts";
import { clampWorkflowWait, isTerminal, type WorkflowRunSnapshot } from "../sdk/workflow-run.ts";
import type { RunReader } from "./workflow-api-events.ts";

/**
 * How often a waiting request re-reads the run.
 *
 * Below what a person perceives as a delay on a fast workflow, and four cheap
 * in-process reads a second on a slow one. Quicker than
 * `RUN_EVENT_POLL_MS` on purpose: the stream is watching something the reader
 * will see anyway, while this interval is added latency on every synchronous
 * call that finishes.
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
  try {
    for (;;) {
      const run = await reader.get(runId);
      if (isTerminal(run) || gone) return run;
      // A run the agent does not know will not start being known, so there is
      // nothing to wait for — but only AFTER a read, so a caller polling an id
      // from a previous deploy gets its answer immediately rather than at the
      // deadline.
      if (!run) return;
      const remaining = deadline - now();
      if (remaining <= 0) return run;
      await sleep(Math.min(pollMs, remaining), { unref: true });
    }
  } finally {
    link.off("close", onClose);
  }
}
