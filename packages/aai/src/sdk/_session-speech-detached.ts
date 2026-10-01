// Copyright 2026 the AAI authors. MIT license.
/**
 * The `SessionSpeech` a context holds when no live session is behind it.
 *
 * Its own module so `session-speech.ts` stays all-public, which is what lets the
 * root barrel re-export it whole. Reached by the host through
 * `@alexkroman1/aai/host-internal`.
 */

import type { SessionSpeech, SpeechHandle } from "./session-speech.ts";

/**
 * The speech of a context with no live session behind it: every line settles
 * `"dropped"` and `interrupt()` answers `false`, the answers an ended session
 * gives.
 *
 * @internal
 */
export const DETACHED_SESSION_SPEECH: SessionSpeech = Object.freeze({
  say: (): SpeechHandle => ({ done: Promise.resolve("dropped"), interrupt: () => undefined }),
  interrupt: () => false,
});
