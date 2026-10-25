// Copyright 2026 the AAI authors. MIT license.
/**
 * How many user turns one session has COMMITTED — what `ctx.turn` reads.
 *
 * One counter per session, claimed beside its emitter and meter in the
 * session directory so a tool call reaches it by session id the way it reaches
 * `ctx.speech`. It counts `userTranscript.committed` — the unit a slot hook and
 * an eval already count — rather than messages in the history: the history is
 * a token-bounded WINDOW (`transports/pipeline/history/retention.ts`), so a
 * long call would read a turn number that stopped growing once the oldest
 * turns were evicted.
 *
 * A resume SEEDS it from the restored history, which is the one place the
 * window is the whole record: the log is replayed into the messages a resume
 * hands `restoreHistory`, and a user message there is a turn the caller took.
 * A `reset` (the client's clear) puts it back to zero with the history it
 * clears.
 *
 * @module
 */

import type { Message } from "@alexkroman1/aai";

/** One session's committed-turn count — see this module's header. @internal */
export type TurnCounter = {
  /** Turns committed so far; `0` before the caller has said anything. */
  readonly count: number;
  /** One more user turn landed. */
  committed(): void;
  /** A resume restored `messages`: count the user turns in them. */
  seed(messages: readonly Message[]): void;
  /** The conversation was cleared. */
  reset(): void;
};

/** Build an empty {@link TurnCounter}. @internal */
export function createTurnCounter(): TurnCounter {
  let count = 0;
  return {
    get count(): number {
      return count;
    },
    committed(): void {
      count += 1;
    },
    seed(messages): void {
      count = messages.filter((message) => message.role === "user").length;
    },
    reset(): void {
      count = 0;
    },
  };
}
