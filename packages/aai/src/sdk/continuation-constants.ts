// Copyright 2026 the AAI authors. MIT license.
/**
 * The continuation window: when the caller starts speaking again right after a
 * turn committed, that speech is the REST of the turn, not a reply to the
 * agent, and the reply already in flight is answering half a sentence.
 *
 * @module
 */

/**
 * How soon after a committed user turn the caller may resume speaking and have
 * it treated as a continuation of that turn, in ms. When it is, the reply in
 * flight for the first fragment is aborted (through the barge-in path, so
 * false-interruption recovery still covers noise) and the next final is
 * answered with both fragments in history. `0` disables it.
 *
 * **Why it exists.** Endpointing commits on a pause, and a caller who pauses
 * mid-sentence — reading out a ZIP, recalling an email — gets split into two
 * turns. Without this, turns run strictly in sequence: the agent answers the
 * first fragment in full ("Please provide your ZIP code.") and only then the
 * second, and a lookup built from the first fragment fails first. A barge-in
 * cannot catch it, because the resumed speech began before the agent had
 * spoken (`utteranceOpenedOverSpeech` is false), so it never takes the floor.
 *
 * **2500, from replay.** On tau2-bench retail audio (32 calls, VAD 0.02,
 * `minTurnSilenceMs` 1600), the caller was detected speaking again a median
 * 1.95s after a split fragment committed (p10 0.99s, p90 4.84s); half resumed
 * within 2.0s. The agent's first audio lands ~1.0-1.3s after a commit, so a
 * window that only covered the silent reply would catch about a third; 2500
 * also covers a reply that has just begun, at the cost of cutting its first
 * words. The second fragment's FINAL lands too late to use (median 5.0s), which
 * is why this keys on resumed speech rather than on the next commit.
 *
 * **3500, from the live run (2026-10-27).** At 2500 on a 114-task retail run
 * (800 / 3500 endpointing — see `DEFAULT_MIN_TURN_SILENCE_MS`, whose 800 floor
 * depends on this), continuation absorbed 117 of 146 split turns; of every
 * reply it cancelled inside the window, 219 were the same sentence resuming and
 * none were a new one. The 29 it missed resumed later than 2.5 s, toward the
 * replay's 4.84 s p90, so the window was widened to catch more of them. That
 * step is extrapolated from those numbers, not yet confirmed on reward; the
 * false-merge count is the thing to watch if it is moved again.
 *
 * **What it costs.** A caller who answers a very fast reply within the window
 * cuts that reply off, as any barge-in would. And it aborts a reply mid tool
 * chain exactly as a barge-in does — no new risk, but not a free one.
 *
 * @defaultValue `3500`
 */
export const DEFAULT_CONTINUATION_WINDOW_MS = 3500;

/**
 * Longest continuation window an agent may declare, in ms. Past this the
 * resumed speech is far more likely a reply to what the agent already said.
 *
 * @internal
 */
export const MAX_CONTINUATION_WINDOW_MS = 6000;
