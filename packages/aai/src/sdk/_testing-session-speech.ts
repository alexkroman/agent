// Copyright 2026 the AAI authors. MIT license.
/**
 * The recording `ctx.speech` behind {@link createToolContext}'s `ctx.said`.
 *
 * Its own module because `_testing-context.ts` is at the source-length cap, and
 * because it is the one recorder there that has two readers: a tool's spec, and
 * an `events` handler's spec, which passes a `createToolContext()` as the
 * handler's context (a `ToolContext` is a superset of `SessionEventContext`).
 */

import type { SayOptions, SessionSpeech, SpeechHandle } from "./session-speech.ts";

/**
 * One `ctx.speech.say` a {@link createToolContext} context recorded.
 *
 * @public
 */
export interface SaidLine {
  /** The text, exactly as passed. */
  readonly text: string;
  /** Whether it asked to cut the agent off first (`{ interrupt: true }`). */
  readonly interrupt: boolean;
}

/**
 * A `SessionSpeech` that records every `say` into `said`, and counts
 * `interrupt()` calls. Every line settles `"played"`: there is no call to cut
 * it, so a handler awaiting `done` runs on to the end, as it would when a
 * caller heard the whole line.
 *
 * @internal
 */
export function recordingSpeech(): {
  speech: SessionSpeech;
  said: SaidLine[];
  interrupts: () => number;
} {
  const said: SaidLine[] = [];
  let interrupts = 0;
  const speech: SessionSpeech = {
    say(text: string, options?: SayOptions): SpeechHandle {
      said.push({ text, interrupt: options?.interrupt === true });
      return { done: Promise.resolve("played"), interrupt: () => undefined };
    },
    interrupt(): boolean {
      interrupts += 1;
      return true;
    },
  };
  return { speech, said, interrupts: () => interrupts };
}
