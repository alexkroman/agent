// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-call option bags `ctx.workflows` takes.
 *
 * Split from `workflow.ts` on the seam that is already there — these describe
 * one CALL, while what stays behind describes a declaration and the client that
 * serves it — and re-exported from it, so an author's import path is unchanged.
 */

/** Per-run options for `WorkflowClient.start`. */
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
   * the run again without the agent maintaining its own index in `ctx.db`.
   *
   * Not unique: starting twice with one key is legal and `find` returns the
   * newest first. Deduplicating is a decision only the caller can make.
   */
  key?: string;
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
