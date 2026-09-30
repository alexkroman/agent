// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-call option bags `ctx.workflows` takes.
 *
 * Split from `workflow.ts` on the seam that is already there — these describe
 * one CALL, while what stays behind describes a declaration and the client that
 * serves it — and re-exported from it, so an author's import path is unchanged.
 */

import type { WorkflowRunStatus } from "./workflow-run.ts";

/**
 * Per-run options for `WorkflowClient.start` — `ctx.workflows.start`, from a
 * TOOL. A caller OUTSIDE the agent (a page, a script) starts a run through
 * `WorkflowApi.start`, whose options are `WorkflowStartOptions`: the same
 * `key`, and a `signal` where this carries `notify`, which needs a session to
 * speak into.
 */
export type StartOptions = {
  /**
   * A caller's own handle on this run, for looking it up again later with
   * `WorkflowClient.find`.
   *
   * **This is the one piece of durable-workflow machinery the Workflow DevKit
   * has no equivalent for, and it is kept because a VOICE agent is broken
   * without it.** `start` resolves with a `runId`; the natural place a tool puts
   * it is a `sessionSlot`, and a session's slot values are swept
   * `SESSION_RESUME_GRACE_MS`
   * after the caller hangs up. So the run outlives the session and the only
   * handle to it does not. Passing `key: ctx.sessionId` (or a phone number, an
   * account id, an upload id) means the next turn — or the next CALL — can find
   * the run again without the agent maintaining an index of its own in a database
   * it brought.
   *
   * Not unique: starting twice with one key is legal and `find` returns the
   * newest first. To make a second start a no-op, pass {@link StartOptions.dedupeKey}.
   */
  key?: string;
  /**
   * Start at most ONE run of this workflow per `dedupeKey`: when a run started
   * with it already exists — in any status, finished or not — `start` resolves
   * THAT run's id and starts nothing.
   *
   * For the start that can be asked twice for one piece of work: a webhook the
   * sender redelivers (key it by the event id), a hook that fires again for the
   * same thing (`${sessionId}:${watermark}`). Without it each app kept a table
   * of seen ids beside the runs, or double-ran on the retry nobody expected.
   *
   * Scoped to the workflow, and as long-lived as the run: the run's id is derived
   * from the workflow and this key, so two racing starts create one run, and the
   * key is free again only once that run has expired from the journal. The
   * input of a deduplicated start is not compared or stored — the first start's
   * is what ran. Independent of {@link StartOptions.key}; pass both to find the
   * run later.
   */
  dedupeKey?: string;
  /**
   * What this run IS, in a line a person reads — `"call the plumber, due 5 PM"`.
   *
   * A snapshot says which workflow a run belongs to, when it started, its key
   * and where it is, and nothing about which of a dozen `remind` runs this one
   * is: the input is not on a snapshot and a run's progress lines are not
   * durable. So a page listing a household's running tasks had to keep a table
   * of its own beside the runs, written by the tool that started each one and
   * joined back on `runId` — a second store that a failed write left out of
   * step with the first. This is that column, kept WITH the run: it is written
   * by the same statement that creates the run, so it is on every snapshot
   * (`get`, `find`, `recent`, `GET /workflows/runs`) whichever journal the
   * deployment has, and it expires when the run does.
   *
   * Normalized, never refused — a label is a courtesy to a reader, and failing a
   * `start` over one would lose the work: control characters become spaces, the
   * text is trimmed and cut at `MAX_WORKFLOW_RUN_LABEL_CHARS` (200), and what is
   * left empty means no label. Set once, at start; there is no way to change it.
   */
  label?: string;
  /**
   * Have the agent SAY SOMETHING when this run finishes, without being asked.
   *
   * `true` takes the default instruction ("tell the caller the result, briefly,
   * in your own words"); a string replaces it. Either way the agent takes an
   * ordinary interruptible turn built from the run's own output — the model
   * writes the sentence, because it is the only thing that knows what the
   * caller has already heard.
   *
   * **This is what makes "I'll let you know" true.** A voice tool that starts
   * durable work answers the turn immediately and the work lands minutes later
   * with no turn to land in, so before this the caller had to think to ask
   * again — and an agent that had promised an update never gave one.
   *
   * Two limits, both by construction. It reaches the session that STARTED the
   * run and only while that session is alive: a run outlives the call, and an
   * announcement into a call that has ended is nobody's. And it needs a
   * transport that can take an unprompted turn — pipeline mode can, S2S has no
   * such verb, so on an S2S agent this is a logged no-op rather than an error.
   * Both are why `key` stays the durable handle: the next call finds the run.
   */
  notify?: boolean | string;
};

/** Options for `WorkflowClient.find`. */
export type FindOptions = {
  /**
   * Most runs to return, newest first. Defaults to
   * `DEFAULT_WORKFLOW_FIND_LIMIT` and is clamped to
   * `MAX_WORKFLOW_FIND_LIMIT`.
   */
  limit?: number;
};

/** Options for `WorkflowClient.findByKey`. */
export type FindByKeyOptions = {
  /**
   * Only runs created at or after this instant (epoch milliseconds or a `Date`).
   */
  since?: number | Date;
  /** Only runs in one of these statuses. Omitted, every status. */
  statuses?: readonly WorkflowRunStatus[];
  /**
   * Most runs to return, newest first ACROSS workflows. Defaults to
   * `DEFAULT_WORKFLOW_FIND_LIMIT` and is clamped to `MAX_WORKFLOW_FIND_LIMIT`;
   * each workflow is read to the same limit before the merge.
   */
  limit?: number;
  /**
   * `false` to leave a completed run's `output` unread — it is `undefined` on
   * every snapshot returned. Default `true`.
   *
   * For a caller that lists runs and never looks at what they returned (a
   * "what is running" panel polling every few seconds): each completed run's
   * output can be a store read of its own, paid for nothing.
   */
  withOutput?: boolean;
};

/** Options for `WorkflowClient.wakeUp`. */
export type WakeUpOptions = {
  /**
   * Interrupt only the `sleep()` calls carrying these correlation ids. Omitted,
   * every pending sleep in the run is interrupted, which is what a "do it now"
   * button means.
   */
  correlationIds?: string[];
};

/** Options for `WorkflowClient.stream`. */
export type StreamOptions = {
  /**
   * Which of the run's streams to read. A run may keep several — `getWritable`
   * takes the same option — so a workflow can separate, say, progress from log
   * output. Omitted, this is the run's default stream.
   */
  namespace?: string;
  /**
   * Chunk index to start from, 0-based and INCLUSIVE — the chunk at this index
   * is the first one you receive. Negative counts back from the end (`-3` reads
   * the last three), which is what a reconnecting reader wants when it does not
   * know how far it got.
   *
   * Defaults to 0 — the whole stream from the beginning, since chunks are
   * retained with the run rather than being live-only. `0` and an omitted value
   * are the same request, which is what makes a cursor safe to send
   * unconditionally: a reader that has consumed `n` chunks passes `n` and
   * receives exactly what it has not seen, with no special case for `n === 0`.
   *
   * **Inclusive is a decision, not a description**, and the alternative shipped
   * briefly. An EXCLUSIVE floor ("what came after the index I last saw") reads
   * naturally for a poll loop and cannot be spelled here: the cursor before
   * chunk 0 is `-1`, and `-1` already means "the last chunk alone". So it forces
   * every caller to special-case its own origin into an omitted parameter, and
   * the off-by-one at that boundary is what a default `followOutput` was losing
   * — the first progress line of every run.
   */
  startIndex?: number;
};
