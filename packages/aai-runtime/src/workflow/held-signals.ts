// Copyright 2026 the AAI authors. MIT license.
/**
 * Payloads signalled AHEAD of the wait they answer, held until the run claims
 * it — `SignalOptions.holdMs`.
 *
 * `WorkflowClient.signal` answers `false` when no hook holds the token, and
 * for one caller that answer is a lost message rather than a run that moved on:
 * a tool that starts a run and signals its first wait in the same turn lands
 * before the body has reached `ctx.waitFor`. The run then parks on a token
 * whose answer was already given and thrown away.
 *
 * So a signal nothing holds may be HELD here, and the wait side takes it when
 * it claims the hook (`workflow/replay/waits.ts`) — delivered through the
 * journal's own `deliverHook`, so what the body reads is a journaled payload
 * exactly as a late signal's is.
 *
 * ## Process memory, deliberately
 *
 * A hold is a courtesy for the seconds between a start and the body's first
 * wait, not a durable mailbox: it is bounded in time (`holdMs`) and in size
 * ({@link MAX_HELD_SIGNALS}), and a restart in that window loses it exactly as
 * the signal was lost before holds existed. Module-level for the reason
 * `workflow/run-context.ts` is — the engine and the walk are one copy of this
 * package in every host (see "The server and the sessions are ONE copy" in the
 * package guide) — so the signaller's `signal` and the walk's `claimHook` read
 * the same map.
 *
 * @internal
 */

/** One held payload. */
type Held = { payload: unknown; expiresAt: number };

/**
 * How many holds are kept at once; the OLDEST goes when a new one arrives
 * past it. A thousand is far above any burst a tool makes, and it is what
 * keeps a signaller that never stops from growing the process.
 */
export const MAX_HELD_SIGNALS = 1000;

const held = new Map<string, Held>();

/** Drop every hold whose window has closed. */
function purgeExpired(now: number): void {
  for (const [token, entry] of held) {
    if (entry.expiresAt <= now) held.delete(token);
  }
}

/**
 * Keep `payload` for a wait on `token` claimed within `holdMs`. A later hold
 * on the same token REPLACES the earlier one — the newest answer is the one
 * meant.
 *
 * @internal
 */
export function holdSignal(token: string, payload: unknown, holdMs: number): void {
  const now = Date.now();
  purgeExpired(now);
  // `Map` keeps insertion order, so the first key is the oldest hold.
  if (held.size >= MAX_HELD_SIGNALS) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  held.delete(token);
  held.set(token, { payload, expiresAt: now + holdMs });
}

/**
 * The payload held for `token`, taken — a second take answers nothing — or
 * `undefined` when none is held or its window has closed.
 *
 * @internal
 */
export function takeHeldSignal(token: string): { payload: unknown } | undefined {
  const entry = held.get(token);
  if (entry === undefined) return undefined;
  held.delete(token);
  if (entry.expiresAt <= Date.now()) return undefined;
  return { payload: entry.payload };
}

/**
 * How many holds are outstanding — for a spec; a hold that has expired but
 * not yet been purged still counts.
 *
 * @internal
 */
export function heldSignalCount(): number {
  return held.size;
}

/** Forget every hold — for a spec's teardown. @internal */
export function clearHeldSignals(): void {
  held.clear();
}
