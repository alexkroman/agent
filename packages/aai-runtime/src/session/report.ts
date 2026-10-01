// Copyright 2026 the AAI authors. MIT license.
/**
 * The TRANSPORT half of a session's inbound surface: one `TransportEventBody`
 * in, the session's reaction and the published event out. The client half is
 * `commands.ts`; `core.ts` composes both.
 */

import type { Logger } from "../logger.ts";
import type { TransportEventBody } from "../transports/types.ts";
import { dispatchReplyDone, type ReplyDoneDeps } from "./reply-done.ts";
import type { ReplyTracker } from "./reply-tracker.ts";
import { runToolStep, type ToolStepDeps } from "./tool-steps.ts";

export type ReportDispatchDeps = {
  sessionId: string;
  emit: ToolStepDeps["emit"];
  log: Logger;
  isStopped: () => boolean;
  /** Re-arm the idle deadline — transport-observed conversation only. */
  resetIdle: () => void;
  replies: ReplyTracker;
  toolStepDeps: ToolStepDeps;
  /** The transport's `hostedTurn` capability: does its host run the model turn? */
  isHostedTurn: () => boolean;
  replyDoneDeps: ReplyDoneDeps;
  /** Append whatever conversation message a reported event contributes. */
  pushConversation: (event: TransportEventBody) => void;
  /** A FATAL error was reported; the session keeps the first code. */
  recordFault: (code: string) => void;
};

/** Build `ServerSession.report`. */
export function createReportDispatcher(
  deps: ReportDispatchDeps,
): (event: TransportEventBody) => void {
  const { emit, log, replies, resetIdle, pushConversation } = deps;

  /** One tool call the transport reported. */
  function handleToolCalled(event: TransportEventBody<"tool.called">): void {
    // WHAT a `tool.called` report means is the transport's declared fact, not a
    // flag the runtime computes beside it. A transport whose HOST runs the model
    // turn (`hostedTurn`: the pipeline) ran the tool already, inside its own
    // model loop through the same call core (`../tools/run-tool-call.ts`), so
    // the report is an OBSERVATION: publish it — unless a relay published it
    // when it asked the client to run the tool, where a second frame is one the
    // client runs twice — and go no further. Executing it here would run the
    // tool a second time and then hang the turn on a result nobody asked for.
    if (deps.isHostedTurn()) {
      if (!deps.toolStepDeps.relayed) emit(event);
      return;
    }
    // Otherwise the SERVICE runs the turn and is waiting for a `tool.result`,
    // so this session executes the call.
    resetIdle();
    // See onReplyStarted: a trailing tool.called during stop()'s transport
    // drain must not start tool work (guest RPC, ctx.generate)
    // against a session already torn down.
    if (deps.isStopped()) return;
    // Bound to the reply that issued the call, by identity — a barge-in or
    // reset swaps in a fresh reply object and the result must land in the
    // orphaned one. See `tool-steps.ts`, which owns the budget, the
    // execution, and the `tool.called` emit itself.
    const p = runToolStep(
      replies.current(),
      { callId: event.toolCallId, name: event.toolName, args: event.args },
      deps.toolStepDeps,
    );
    // `!== undefined`, not truthiness: a promise is always truthy, and the
    // absence of one is the signal (the step budget refused the call).
    if (p !== undefined) replies.chainTool(p);
  }

  return (event) => {
    switch (event.type) {
      case "reply.completed":
        // The PROVIDER's claim, not the turn's end — and so the one report whose
        // name and whose emitted event can come apart. `reply-done.ts` is
        // entirely about the three ways a `reply.done` is not the end, and it
        // emits `audio.completed` + `reply.completed` itself when it is.
        dispatchReplyDone(deps.replyDoneDeps);
        return;
      case "reply.cancelled":
        replies.cancel();
        break;
      case "tool.called":
        handleToolCalled(event);
        return;
      case "userTranscript.committed":
        resetIdle();
        emit(event);
        pushConversation(event);
        return;
      case "userTranscript.updated":
        // Partials too, not just the committed turn: one long utterance would
        // otherwise only count at its `speech.started`, and could be reaped
        // mid-sentence.
        resetIdle();
        break;
      case "agentTranscript.committed":
        resetIdle();
        replies.current().flushedAwaitingContinuation = false;
        emit(event);
        // The COMMITTED event only, which is what makes the stream's assistant
        // turns the session's own rather than a re-derivation. An INTERRUPTED
        // reply is reported as `.updated` and enters no history — see the event's
        // own doc, and "History records what was HEARD" in
        // `transports/pipeline/CLAUDE.md`. A committed RECOVERY phrase is
        // emitted, because the caller heard it, and recorded too.
        pushConversation(event);
        return;
      case "agentTranscript.updated":
        resetIdle();
        replies.current().flushedAwaitingContinuation = false;
        break;
      case "speech.started":
        resetIdle();
        break;
      case "error.reported": {
        // Logged as well as emitted, so a session killed by an upstream
        // provider (an STT session cap, a provider deploy) is answerable from
        // the server's logs and not only from whatever the client did with the
        // frame. `fatal` defaults to true: only an explicit `fatal: false` is
        // non-terminal.
        const entry = { sid: deps.sessionId, code: event.code, message: event.message };
        if (event.fatal === false) log.debug("session error", entry);
        else {
          log.warn("session error (fatal)", entry);
          deps.recordFault(event.code);
        }
        break;
      }
      // FORWARDED: nothing for the session to do but publish them. Listed by
      // name rather than left to a `default`, so that an event added to the
      // vocabulary is a compile error below until somebody decides whether the
      // session has to act on it.
      case "audio.completed":
      case "metrics.collected":
      case "provider.failedOver":
      case "tool.completed":
        // Only a hosted turn reports one (the session emits its own for the
        // calls it runs, in `tool-steps.ts`); under a relay the client already
        // has the result it computed.
        if (deps.toolStepDeps.relayed) return;
        break;
      case "speech.stopped":
      case "userTurn.exceeded":
        break;
      default: {
        // Unreachable by type; at runtime an untyped transport's unknown report
        // is still published, as it always was.
        const unclassified: never = event;
        emit(unclassified);
        return;
      }
    }
    emit(event);
  };
}
