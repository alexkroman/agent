// Copyright 2026 the AAI authors. MIT license.
/**
 * Push-to-talk's three edges on the browser session — `session.userTurn`'s
 * `start`, `commit` and `clear` — for an agent that declares
 * `turnDetection: "manual"`.
 *
 * Split out of `session-core.ts` at the source-length cap. Each is a frame to
 * the server; what the server does with it is `aai-runtime`'s
 * `pipeline-manual-turn.ts`. The two things done HERE rather than waiting a
 * round trip for are the reason these are more than `sendJson` calls: a press
 * stops the agent's queued audio at once, and a discarded turn's caption is
 * cleared because no transcript for it will ever arrive.
 *
 * @module
 */

import type { SessionCommand } from "@alexkroman1/aai/protocol";
import type { SessionStateMachine } from "./session-core-state.ts";
import type { SessionSnapshot, UserTurnControls } from "./session-core-types.ts";

/** What the three edges need from the session around them. @internal */
export type UserTurnDeps = {
  snapshot: () => SessionSnapshot;
  /** A socket is open and can carry a frame. */
  connected: () => boolean;
  /** The local turn boundary — see `bargeIn` in `session-core-types.ts`. */
  bargeIn: () => void;
  agentState: SessionStateMachine;
  updateState: (partial: Partial<SessionSnapshot>) => void;
  sendJson: (msg: SessionCommand) => void;
};

/** Build the three push-to-talk edges. @internal */
export function createUserTurnActions(deps: UserTurnDeps): UserTurnControls {
  return {
    start(): void {
      if (!deps.connected()) return;
      // The agent stops the moment the button goes down, the same local
      // barge-in `cancel()` makes — only when there is something to stop, so a
      // press into silence leaves a "listening" state alone. The server's
      // `reply.cancelled` follows and finds nothing left to flush.
      const { state } = deps.snapshot();
      if (state === "speaking" || state === "thinking") {
        deps.bargeIn();
        deps.updateState(deps.agentState.apply({ type: "LISTEN" }));
      }
      deps.sendJson({ type: "user_turn_start" });
    },
    commit(): void {
      if (!deps.connected()) return;
      deps.sendJson({ type: "user_turn_commit" });
    },
    clear(): void {
      if (!deps.connected()) return;
      // The server shows nothing more of a discarded turn, so the caption it
      // left behind is cleared here rather than waiting for a transcript that
      // will never come.
      deps.updateState({ userTranscript: null });
      deps.sendJson({ type: "user_turn_clear" });
    },
  };
}
