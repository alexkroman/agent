// Copyright 2026 the AAI authors. MIT license.
/**
 * A WRITE runs only on a caller turn the caller spoke into silence.
 *
 * The prompt asks for a clear yes before an action that's hard to undo, and
 * the model reads its yes from the transcript — which cannot show that the
 * words were spoken OVER the agent. Recorded on tau2-bench retail: an "uh-huh"
 * over the agent's question committed as the answer to it (task 12), one
 * transcribed "Yes. Uh-huh." while playback had not yet reached the question
 * (task 18), and an "Uh-huh." over a dead-air filler preceded a return the
 * caller never confirmed (task 25). In each, the turn that authorized the
 * write began while agent audio was on the line.
 *
 * So the check is made here, in code, on facts the model cannot see: did the
 * turn that started this reply open over the agent's audio, filler included,
 * AND was it brief — a backchannel's length, under the sustained-speech gate?
 * Then a tool declared `annotations.readOnlyHint: false` is not run, and the
 * model is told to ask once more and wait. Content-blind: nothing reads what
 * was said.
 *
 * **Overlap alone was the first rule, and it refused real answers.** Callers
 * start answering over the tail of a question: "Yeah, cancel that charger
 * order" began ~1.4s before the question finished, twice (tau2 task 32), and
 * the agent took the refusal as final and transferred; task 6 lost ~60s to
 * re-asks the same way. By how much of the question it talked over, that is
 * indistinguishable from task 12's "uh-huh" (~1.2s before the end). By length
 * it is not: an acknowledgement is ~0.3s of speech. The cost accepted: a
 * longer non-answer over the question (task 18's "Yes. Uh-huh.", ~1s, with an
 * STT-inserted "Yes.") now passes, and only the prompt's heard-yes rule covers
 * it. Classified where the turn commits (`isBackchannel` in `stt-handlers.ts`).
 *
 * The refusal is worded as an ordinary result, not an `Error…`, so the failed
 * call memo does not refuse the identical call once the caller has confirmed.
 */

import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { Logger } from "../logger.ts";

/** @internal */
export const UNCONFIRMED_WRITE_RESULT: string =
  "Not done yet, and nothing was changed: the caller's last turn was a short " +
  "acknowledgement spoken while you were still talking, not an answer to your question. " +
  "Ask them once more whether to go ahead, then stop talking and wait — they may well " +
  "agree, and once they answer, call the tool again. This is not a failure of the " +
  "action itself.";

/** Names of the tools a declaration marks as writes. @internal */
export function writeToolNames(schemas: readonly ToolSchema[]): ReadonlySet<string> {
  return new Set(schemas.filter((s) => s.annotations?.readOnlyHint === false).map((s) => s.name));
}

/**
 * Wrap `executeTool` so a declared write runs only when `turnWasBackchannel()`
 * is false. With no declared writes it returns `executeTool` itself.
 *
 * @internal
 */
export function withConfirmationGate(
  executeTool: ExecuteTool,
  deps: {
    schemas: readonly ToolSchema[];
    /** Was the caller turn that started this reply a backchannel over the agent? */
    turnWasBackchannel: () => boolean;
    log: Logger;
    sid: string;
  },
): ExecuteTool {
  const writes = writeToolNames(deps.schemas);
  if (writes.size === 0) return executeTool;
  return (name, args, sessionId, messages, options) => {
    if (writes.has(name) && deps.turnWasBackchannel()) {
      deps.log.info("Pipeline write refused: turn was a backchannel over the agent", {
        sid: deps.sid,
        tool: name,
      });
      return Promise.resolve(UNCONFIRMED_WRITE_RESULT);
    }
    return executeTool(name, args, sessionId, messages, options);
  };
}
