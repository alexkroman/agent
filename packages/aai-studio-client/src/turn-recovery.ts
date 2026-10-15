// Copyright 2026 the AAI authors. MIT license.
/**
 * Recovering a turn the sandbox dropped mid-stream: send it again, once, on a
 * fresh sandbox — so a platform deploy that terminates the guest under a
 * running turn costs the user a restart notice rather than an error and a
 * retype.
 *
 * The guest is gone for an ordinary reason. A replica going down waits for the
 * turns in its studio guests only as long as its shutdown budget allows
 * (`STUDIO_SHUTDOWN_DRAIN_MS`, aai-studio-server), and a coding-agent turn
 * can run for minutes.
 *
 * **Regenerate, never re-send.** The dropped turn left a partial assistant
 * reply in the transcript; `regenerate()` removes it and posts the
 * conversation that ends in the user's message, so the new guest answers the
 * same prompt and nothing is duplicated. On the wire it is the same
 * whole-conversation POST: the guest persists that snapshot before running
 * the turn, REPLACING the one the dead guest persisted, so the stored
 * history gets no second copy of the user message either. Re-sending the
 * text would append one.
 *
 * The regeneration's request goes through the transport like any other, so
 * the dead lease it starts on is re-brokered there (sandbox-transport.ts).
 *
 * **Once.** A regeneration that drops too is reported, not retried: a guest
 * that dies twice in a row is not a deploy, and an unbounded loop re-runs a
 * turn's edits each time.
 *
 * It wraps `sendMessage` rather than reacting to the chat's `error` status,
 * because the follow-up queue reads that status as "this turn failed — hand
 * the queue back" (chat-queue.ts). `onRecovering` is what the panel shows in
 * the meantime, and what keeps the queue reading the turn as still running.
 */

import { TurnDroppedError } from "./resilient-fetch.ts";

export type TurnRecoveryOptions = {
  /** `useChat`'s `sendMessage`: resolves when the turn is over, however it ended. */
  sendMessage: (message: { text: string }) => Promise<void>;
  /** `useChat`'s `regenerate`, for the last turn. */
  regenerate: () => Promise<void>;
  /** A dropped turn is being sent again (true), or that is over (false). */
  onRecovering: (recovering: boolean) => void;
};

export type TurnRecovery = {
  /** Every turn the panel starts goes through here instead of `sendMessage`. */
  send(message: { text: string }): Promise<void>;
  /** `useChat`'s `onError`: runs before the chat reports the error. */
  onError(error: Error): void;
};

export function createTurnRecovery(options: TurnRecoveryOptions): TurnRecovery {
  /** The turn in flight dropped and has not been regenerated yet. */
  let dropped = false;
  /** The regeneration is in flight; a drop now is final. */
  let regenerating = false;
  return {
    onError(error) {
      if (!(error instanceof TurnDroppedError) || regenerating) return;
      dropped = true;
      options.onRecovering(true);
    },
    async send(message) {
      await options.sendMessage(message);
      if (!dropped) return;
      dropped = false;
      regenerating = true;
      try {
        await options.regenerate();
      } finally {
        regenerating = false;
        options.onRecovering(false);
      }
    },
  };
}
