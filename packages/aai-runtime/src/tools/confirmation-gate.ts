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
 * So the check is made here, in code, on a fact the model cannot see: did the
 * turn that started this reply open over the agent's audio, filler included?
 * If it did, a tool declared `annotations.readOnlyHint: false` is not run, and
 * the model is told to ask and wait. A barge-in can only start over agent
 * audio, so a turn that CUT a reply is refused by the same test. Content-blind:
 * nothing reads what was said, so a genuine "yes" spoken after the question
 * passes, and one spoken over it costs one re-ask.
 *
 * The refusal is worded as an ordinary result, not an `Error…`, so the failed
 * call memo does not refuse the identical call once the caller has confirmed.
 */

import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { Logger } from "../logger.ts";

/** @internal */
export const UNCONFIRMED_WRITE_RESULT: string =
  "Not done. The caller's last turn was spoken while you were still talking, so it " +
  "cannot be their answer to anything you asked. Nothing was changed. Ask them to " +
  "confirm this action now, and wait for their reply before calling the tool again.";

/** Names of the tools a declaration marks as writes. @internal */
export function writeToolNames(schemas: readonly ToolSchema[]): ReadonlySet<string> {
  return new Set(schemas.filter((s) => s.annotations?.readOnlyHint === false).map((s) => s.name));
}

/**
 * Wrap `executeTool` so a declared write runs only when `turnOverlapped()` is
 * false. With no declared writes it returns `executeTool` itself.
 *
 * @internal
 */
export function withConfirmationGate(
  executeTool: ExecuteTool,
  deps: {
    schemas: readonly ToolSchema[];
    /** Did the caller turn that started this reply open over agent audio? */
    turnOverlapped: () => boolean;
    log: Logger;
    sid: string;
  },
): ExecuteTool {
  const writes = writeToolNames(deps.schemas);
  if (writes.size === 0) return executeTool;
  return (name, args, sessionId, messages, options) => {
    if (writes.has(name) && deps.turnOverlapped()) {
      deps.log.info("Pipeline write refused: turn spoke over the agent", {
        sid: deps.sid,
        tool: name,
      });
      return Promise.resolve(UNCONFIRMED_WRITE_RESULT);
    }
    return executeTool(name, args, sessionId, messages, options);
  };
}
