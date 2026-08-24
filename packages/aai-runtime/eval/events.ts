// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading an agent's behaviour off the session event stream.
 *
 * Three questions an eval asks of a run — where one reply ends, what the agent
 * SAID, and which tools it called — answered from {@link SessionEvent}s and
 * nothing else. No log scraping, no provider internals, no reaching into the
 * transport: the questions this repo's guides ask of an agent ("did it call the
 * right tool with the right arguments", "did it call them in that order", "how
 * many `speech.started` against how many `reply.cancelled`") are all questions
 * about a list of typed events.
 *
 * These are READERS, not assertions. An eval writes its claims in whatever
 * runner it already has — `expect` in a vitest file, or the recording runner in
 * `aai-evals` for a case that must profile rather than bisect — and reads the
 * facts from here.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";

/** One tool call, paired with its result when the stream carries one. */
export type EvalToolCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The serialized result, or undefined when the call never completed. */
  readonly result?: string;
};

/**
 * The events that END a reply.
 *
 * Declared ONCE, because two things must agree by construction: they partition
 * a run into turns for anything reading {@link toolCallsIn} per reply, and they
 * are what `openEvalSession`'s `say()` waits for. The set used to be written out
 * in two files, and a third terminator added to one copy would make `say()`
 * return mid-reply while the assertions still thought the turn was open — which
 * reads as the agent misbehaving rather than as a harness bug.
 */
export const TURN_ENDS: ReadonlySet<SessionEvent["type"]> = new Set([
  "reply.completed",
  "reply.cancelled",
]);

/**
 * The committed agent replies in `events`, in order — what the caller was told.
 *
 * Committed rather than streamed: a delta is a draft, and a reply the pipeline
 * cancelled mid-sentence was never heard in full. Asserting on deltas is how an
 * eval comes to pass on text no caller received.
 */
export function saidIn(events: readonly SessionEvent[]): readonly string[] {
  return events.flatMap((e) => (e.type === "agent-transcript.committed" ? [e.text] : []));
}

/**
 * The tool calls in `events`, each paired with the result event that answered
 * it. A call with no result is a call that never completed — reported as such
 * rather than dropped, because "it called the tool and the tool never returned"
 * is a finding.
 */
export function toolCallsIn(events: readonly SessionEvent[]): readonly EvalToolCall[] {
  const results = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool.completed") results.set(event.toolCallId, event.result);
  }
  const calls: EvalToolCall[] = [];
  for (const event of events) {
    if (event.type !== "tool.called") continue;
    const result = results.get(event.toolCallId);
    calls.push({
      toolCallId: event.toolCallId,
      name: event.toolName,
      args: event.args,
      ...omitUndefined({ result }),
    });
  }
  return calls;
}
