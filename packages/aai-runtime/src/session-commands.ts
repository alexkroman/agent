// Copyright 2026 the AAI authors. MIT license.
/**
 * What the CLIENT asks the session to do — one dispatcher over the command
 * vocabulary.
 *
 * Split out of `session-core.ts` at the 500-line cap, along the seam that file's
 * module doc draws: a session has two things talking to it, and this is the half
 * that speaks `sdk/protocol-commands.ts`. `session-reply-done.ts` and
 * `session-tool-steps.ts` came out of the same file on the same principle.
 *
 * Every case here is a decision rather than a forward, which is why the switch
 * reads long for eight commands: two of them deliberately do LESS than the obvious
 * thing (`audio_ready` is inert, `playback_progress` does not touch the idle
 * deadline) and one deliberately does less than its transport-reported namesake
 * (`cancel` aborts the reply's tools without swapping the reply object).
 *
 * @module
 */

import type { SessionCommand } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { Transport } from "./transports/types.ts";

/** What the command dispatcher needs from the session around it. */
export type CommandDeps = {
  sessionId: string;
  emit: SessionEmitter["emit"];
  log: Logger;
  transport: Transport;
  /**
   * Abort the in-flight reply's tool executions WITHOUT replacing the reply —
   * see the `cancel` case. Distinct from {@link CommandDeps.cancelReply}, and
   * the difference is load-bearing rather than incidental.
   */
  abortReplyTools: () => void;
  /** Discard the in-flight reply and start a fresh one. */
  cancelReply: () => void;
  /** Drop the conversation this session has accumulated. */
  clearHistory: () => void;
  /** Host/relay mode: settle a pending relayed call. */
  onToolResult?:
    | ((message: { toolCallId: string; result: string; error?: string }) => void)
    | undefined;
};

/** One session's command dispatcher. */
export type CommandDispatcher = (cmd: SessionCommand) => void;

/**
 * Build the command dispatcher for one session.
 *
 * A factory rather than a bare function because of `sawPlaybackReport`: the
 * once-per-session log below is per-session state, and it belongs to the only
 * code that reads it rather than to `session-core.ts`'s closure.
 *
 * @internal
 */
export function createCommandDispatcher(deps: CommandDeps): CommandDispatcher {
  const { sessionId, emit, log, transport } = deps;
  let sawPlaybackReport = false;
  // Once per session, like `sawPlaybackReport`: a transport with no turn verbs
  // (both S2S services) is sent the same three commands on every press.
  let warnedNoTurnVerbs = false;
  const turnVerbsOrWarn = (type: string): boolean => {
    if (transport.startUserTurn !== undefined) return true;
    if (!warnedNoTurnVerbs) {
      warnedNoTurnVerbs = true;
      log.warn(
        `Client sent ${type}, but this session's transport cannot end a caller's turn — push-to-talk needs a pipeline agent declaring turnDetection: "manual".`,
        { sid: sessionId },
      );
    }
    return false;
  };
  /** The three push-to-talk edges — see the verbs on `Transport`. */
  const userTurn = (type: "user_turn_start" | "user_turn_commit" | "user_turn_clear"): void => {
    if (!turnVerbsOrWarn(type)) return;
    if (type === "user_turn_commit") {
      transport.commitUserTurn?.();
      return;
    }
    if (type === "user_turn_clear") {
      transport.clearUserTurn?.();
      return;
    }
    // Opening a turn interrupts the agent the way a client `cancel` does — and
    // exactly when there was something to interrupt, so a press into silence
    // reports no cancellation that did not happen.
    if (transport.startUserTurn?.() === true) {
      deps.abortReplyTools();
      emit({ type: "reply.cancelled" });
    }
  };

  return function dispatch(cmd: SessionCommand): void {
    switch (cmd.type) {
      case "audio_ready":
        // Intentionally inert, and there is no override mechanism: greeting
        // dispatch is the transport's own business. S2S greets automatically, and
        // the pipeline transport has an internal `onAudioReady` fired by
        // pipeline-providers.ts when the provider sockets open — unrelated to
        // this client frame. The frame is accepted (clients send it) and ignored;
        // `TransportCallbacks` deliberately has no member for it.
        return;
      case "cancel":
        // Stop the in-flight tools' work promptly — the user has abandoned this
        // turn, and without the abort a tool keeps running (network calls, db
        // writes) into a turn the client already displays as cancelled. The
        // reply object is deliberately NOT swapped (unlike a transport-reported
        // `reply.cancelled`): the aborted tools still settle into pendingTools,
        // and an S2S provider — which has no cancel RPC — is still awaiting
        // tool.result for the calls it issued; flushing the (error) results on
        // reply.done is what hands its turn back. Audio stays suppressed by
        // the transport until the next reply.
        deps.abortReplyTools();
        transport.cancelReply();
        emit({ type: "reply.cancelled" });
        return;
      case "user_turn_start":
      case "user_turn_commit":
      case "user_turn_clear":
        userTurn(cmd.type);
        return;
      case "reset":
        deps.cancelReply();
        deps.clearHistory();
        // Clear conversation state the transport owns (pipeline LLM history);
        // without this the "forgotten" dialogue keeps feeding the next turn.
        transport.reset?.();
        emit({ type: "session.reset" });
        return;
      case "playback_progress":
        // Logged ONCE per session, because "is this client closed-loop?" changes
        // how every playback-derived number in the session should be read — the
        // barge-in floor, the heard cursor, the speaking-edge gate. A session
        // with no such line ran on the open-loop estimate, and the absence is
        // indistinguishable from a client that simply never buffers unless it is
        // stated somewhere. Once, not per report: these arrive every few hundred
        // ms for the whole of every reply.
        if (!sawPlaybackReport) {
          sawPlaybackReport = true;
          log.info("Client reports playback progress", {
            sid: sessionId,
            bufferedMs: cmd.bufferedMs,
          });
        }
        // Deliberately does NOT re-arm the idle timer: this frame reports the
        // agent's own audio playing back, which is not evidence the caller is
        // still there — the session's `resetIdle` measures silence from the user.
        transport.onPlaybackProgress?.(cmd.bufferedMs);
        return;
      case "tool_result":
        deps.onToolResult?.({
          toolCallId: cmd.toolCallId,
          result: cmd.result,
          ...omitUndefined({ error: cmd.error }),
        });
        return;
      default:
        // Forward compatibility, the same reason `lenientParse` tolerates an
        // unknown-but-valid type rather than warning about it.
        return;
    }
  };
}
