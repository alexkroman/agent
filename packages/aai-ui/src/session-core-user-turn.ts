// Copyright 2026 the AAI authors. MIT license.
/**
 * Push-to-talk's three edges on the browser session — `session.userTurn`'s
 * `start`, `commit` and `clear` — for an agent that declares
 * `turnDetection: "manual"`; and `session.sendText`, a turn the caller TYPED.
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
import type {
  SendTextOptions,
  SessionSnapshot,
  ToolCallOutcome,
  UserTurnControls,
} from "./session-core-types.ts";

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
  /**
   * Typed turns waiting for a session — `sendText(text, { connect: true })`
   * while none is up. OWNED by the session core, which empties it whenever the
   * session stops being meant to run (`running: false`): a hang-up, `end()`, a
   * terminal close. A message typed into a call that then failed must not be
   * answered by the next one.
   */
  queued: string[];
  /** Bring the session up if it is not meant to be running — `start()` or `toggle()`. */
  open: () => void;
};

/**
 * The local half of an interruption: the agent stops here at once, the same
 * barge-in `cancel()` makes — only when there is something to stop, so a
 * press or a message into silence leaves a "listening" state alone. The
 * server's `reply.cancelled` follows and finds nothing left to flush.
 */
function interruptLocally(deps: UserTurnDeps): void {
  const { state } = deps.snapshot();
  if (state === "speaking" || state === "thinking") {
    deps.bargeIn();
    deps.updateState(deps.agentState.apply({ type: "LISTEN" }));
  }
}

/**
 * Everything a caller's turn can be started by: push-to-talk's three edges
 * and a TYPED turn — `session.userTurn` and `session.sendText`. One builder
 * over one set of deps, because both are the same kind of thing (a user turn
 * the client, not the transcriber, delimits) and both interrupt the same way.
 *
 * @internal
 */
export function createUserInput(deps: UserTurnDeps): {
  userTurn: UserTurnControls;
  sendText: (text: string, options?: SendTextOptions) => void;
  /** A session came up (a `config` frame): send what was typed while it was not. */
  flushQueued: () => void;
  sendToolResult: (toolCallId: string, outcome: ToolCallOutcome) => void;
} {
  function send(trimmed: string): void {
    // Typing over the agent means to replace what it is saying, exactly as
    // pressing the button does.
    interruptLocally(deps);
    // No local echo into `messages`: the server answers with the same
    // `userTranscript.committed` a spoken turn produces, and THAT is what
    // adds the row — so a resumed session, which replays the stream, shows
    // exactly what this one did.
    deps.sendJson({ type: "user_text", text: trimmed });
  }
  return {
    userTurn: createUserTurnActions(deps),
    sendText(text: string, options?: SendTextOptions): void {
      // Trimmed here as well as on the server so an empty message is not a
      // frame the server has to reject (and warn about).
      const trimmed = text.trim();
      if (trimmed === "") return;
      if (deps.connected() && deps.queued.length === 0) {
        send(trimmed);
        return;
      }
      // Nothing is waiting and the caller did not ask for a session: the
      // documented no-op while disconnected. Anything behind a waiting message
      // queues too, never ahead of it — the order is what was typed.
      if (deps.queued.length === 0 && options?.connect !== true) return;
      deps.queued.push(trimmed);
      deps.open();
    },
    flushQueued(): void {
      if (!deps.connected()) return;
      for (const text of deps.queued.splice(0)) send(text);
    },
    // Not a turn, but the same kind of frame: the page answering the agent.
    sendToolResult(toolCallId: string, outcome: ToolCallOutcome): void {
      if (!deps.connected()) return;
      deps.sendJson({ type: "tool_result", toolCallId, ...encodeOutcome(outcome) });
    },
  };
}

/**
 * The frame's two fields. A result `JSON.stringify` cannot encode (a cycle, a
 * `BigInt`, a bare function) fails the call naming why, rather than throwing
 * into the handler that produced it or leaving the server waiting.
 */
function encodeOutcome(outcome: ToolCallOutcome): { result: string; error?: string } {
  if ("error" in outcome) return { result: "", error: outcome.error };
  try {
    return { result: JSON.stringify(outcome.result ?? null) ?? "null" };
  } catch (err: unknown) {
    return { result: "", error: `Tool result is not JSON-serializable: ${String(err)}` };
  }
}

/** Build the three push-to-talk edges. @internal */
export function createUserTurnActions(deps: UserTurnDeps): UserTurnControls {
  return {
    start(): void {
      if (!deps.connected()) return;
      // The agent stops the moment the button goes down.
      interruptLocally(deps);
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
