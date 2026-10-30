// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming TTS service's CONTROL-frame budget, kept client-side
 * so the adapter never trips it.
 *
 * **The limit, as documented** (https://www.assemblyai.com/docs/tts/limits,
 * "Pacing"): `Flush`, `KeepAlive`, `Cancel` and an empty `Generate` share one
 * budget of 20 per second sustained, with a burst allowance of about 60. A
 * `Generate` with text and `Terminate` are not counted. Exceeding it closes the
 * session with `3010` — `Control frame rate exceeded: more than 20
 * Flush/KeepAlive/Cancel frames or empty Generates per second sustained`.
 *
 * The adapter flushes per sentence segment, so a fast LLM emitting many short
 * sentences used to send one `Flush` per sentence with nothing between them and
 * the limit: observed in a tau2 run, ~79 segments inside a second, then 3010
 * and a session that was mute until the caller hung up.
 *
 * **This is a token bucket at HALF the documented rate with a burst of 10**, so
 * any one-second window holds at most 10 + 10 = 20 frames: within the sustained
 * limit with no reliance on the service's burst allowance, because the exact
 * accounting window is not documented and the docs say the values may change.
 * The cost is nil for a voice reply — a `Flush` held back waits at most
 * ~100 ms while earlier segments' audio is still playing. Flushes may only spend the bucket down to
 * {@link CONTROL_FRAME_RESERVE}; the reserve belongs to `Cancel` (a barge-in
 * must never wait) and `KeepAlive`, which spend unconditionally. A `Flush` that
 * finds the bucket at the reserve is not dropped — the adapter keeps buffering,
 * and the text that lands meanwhile is merged into the NEXT flush, which is
 * both fewer frames and better prosody (`assemblyai-segment.ts`).
 */

/** Tokens the bucket holds when full — the burst we allow ourselves. */
export const CONTROL_FRAME_BURST = 10;
/** Tokens restored per second — the sustained rate we allow ourselves. */
export const CONTROL_FRAMES_PER_SECOND = 10;
/** Tokens a `Flush` may not spend: kept for `Cancel` and `KeepAlive`. */
export const CONTROL_FRAME_RESERVE = 4;

/** One session's control-frame bucket. */
export interface ControlBudget {
  /**
   * Take one token if more than `floor` remain; returns whether it did. What a
   * `Flush` calls, with `floor` = {@link CONTROL_FRAME_RESERVE}.
   */
  tryTake(floor: number): boolean;
  /**
   * Take one token unconditionally, even past empty — for a frame that must
   * go out regardless (`Cancel`, `KeepAlive`). Overdraft is paid back by the
   * refill before any `Flush` can spend again.
   */
  take(): void;
  /** Milliseconds until {@link tryTake} with this `floor` would succeed. */
  msUntil(floor: number): number;
}

/**
 * Create a {@link ControlBudget}. `now` is read per call, so fake timers reach
 * it through `Date.now`.
 */
export function createControlBudget(
  opts: { burst?: number; perSecond?: number; now?: () => number } = {},
): ControlBudget {
  const burst = opts.burst ?? CONTROL_FRAME_BURST;
  const perMs = (opts.perSecond ?? CONTROL_FRAMES_PER_SECOND) / 1000;
  const now = opts.now ?? (() => Date.now());
  let tokens = burst;
  let at = now();

  const refill = (): void => {
    const t = now();
    tokens = Math.min(burst, tokens + Math.max(0, t - at) * perMs);
    at = t;
  };

  return {
    tryTake(floor) {
      refill();
      if (tokens - 1 < floor) return false;
      tokens -= 1;
      return true;
    },
    take() {
      refill();
      tokens -= 1;
    },
    msUntil(floor) {
      refill();
      const missing = floor + 1 - tokens;
      return missing <= 0 ? 0 : Math.ceil(missing / perMs);
    },
  };
}
