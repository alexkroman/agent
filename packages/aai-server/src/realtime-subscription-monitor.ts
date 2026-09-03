// Copyright 2026 the AAI authors. MIT license.
/**
 * Whether the Realtime change streams are actually DELIVERING — the
 * per-channel join/drop tracker behind {@link PlatformEventsHealth}.
 *
 * Split out of `realtime-events.ts` (which was at the file-length cap) along
 * the seam that was already there: that module owns channel topology — topics,
 * filters, refcounting, signal extraction — and this one owns the single
 * question "is this channel up, and if not, for how long". The two touch at
 * exactly one point, the subscribe callback `track` returns.
 *
 * The failure this exists for is described on {@link ChannelState}: realtime-js
 * rejoins forever, so a channel that cannot deliver looks identical to a
 * healthy one except in the rate of a log line.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createLogger } from "./logger.ts";
import type { PlatformEventsHealth } from "./platform-events.ts";

const log = createLogger("platform.realtime");

/**
 * How long a channel may go without acking a join before it counts as
 * STALLED rather than merely slow.
 *
 * Generous on purpose. A join crosses the socket and Realtime's own
 * authorization, and realtime-js reconnects with backoff, so a few seconds of
 * failure during a deploy or a network blip is ordinary. What this has to
 * separate is that from the failure mode below, which never recovers on its
 * own and never stops retrying.
 */
const JOIN_BUDGET_MS = 30_000;

/**
 * Per-channel join tracking — the thing that turns "changes silently stopped
 * being delivered" into something observable.
 *
 * A subscribe that can never succeed is this platform's most expensive quiet
 * failure (see {@link PlatformEventsHealth}), and its whole signature is an
 * infinite retry: realtime-js rejoins forever, so the ONLY difference between
 * a wedged channel and a healthy one used to be the rate of a warn line.
 * That is invisible in two directions at once — nobody watches for a warn, and
 * a warn per retry is indistinguishable from a warn per blip.
 *
 * So failures are counted per channel instead of narrated: an ordinary
 * failure still warns, a channel DOWN past the budget escalates ONCE to
 * `log.error`, and {@link health} reports it for as long as it lasts.
 *
 * **`up` is a current state, not a high-water mark, and that distinction is the
 * whole fix.** This tracked a boolean `joined` that was set on the first
 * `SUBSCRIBED` and never cleared, so the model only had "never joined" in it.
 * A channel that joined and dropped hours later — which is what production
 * does, twice in one evening on `aai:agents` — was therefore held to be
 * healthy forever: `isStalled` could not fire (it required `!joined`), so
 * `health()` reported nothing, the escalation was unreachable, and each retry
 * printed one indistinguishable warn. A permanent drop after a successful join
 * was the one outage this monitor could not see, and it is the WORSE one,
 * because changes were being delivered and then stopped.
 *
 * Recovery is reported for the same reason. Every join fires the channel's
 * watchers, so a rejoin already repairs the data (`createChannelPool`, and
 * `watchAgents`'s `onResync`) — but silently, so nothing said how long the gap
 * was, and a redeploy inside it is exactly what leaves a replica serving
 * superseded code until something else notices.
 */
type ChannelState = {
  /** When the CURRENT up-or-down period began. */
  since: number;
  /** Currently joined, as of the last status we saw. */
  up: boolean;
  /** Has ever acked a join — what separates a first join from a REjoin. */
  everJoined: boolean;
  /** Down periods so far; a rising count is a flapping socket. */
  outages: number;
  /** Escalated for the CURRENT down period — reset by a rejoin. */
  escalated: boolean;
};

/** Down, and out of budget — whether or not it ever joined. */
function isStalled(state: ChannelState, now: number): boolean {
  return !state.up && now - state.since >= JOIN_BUDGET_MS;
}

/** How long the current period has lasted, in whole seconds. */
function secondsSince(since: number, now: number): number {
  return Math.round((now - since) / 1000);
}

/**
 * One failed join: ordinary until the budget lapses, then escalated ONCE per
 * down period. Once, because the retry is infinite — a per-retry error would
 * become the log rather than a finding in it; per PERIOD rather than per
 * process, because a channel that recovers and breaks again is two findings.
 */
function reportFailure(
  topic: string,
  state: ChannelState,
  status: string,
  err: Error | undefined,
): void {
  const now = Date.now();
  const detail = err ? ` (${errorMessage(err)})` : "";
  if (state.up) {
    // The transition itself, which is the one moment a drop is cheap to notice.
    // Warn rather than error: realtime-js reconnects with backoff and most of
    // these last seconds, so the finding is the escalation below.
    state.up = false;
    state.since = now;
    state.outages += 1;
    log.warn(
      `channel ${topic} DROPPED after ${status}${detail} — it had been joined, so changes ` +
        "are not being delivered until it rejoins (a deploy in this window moves no " +
        "resident sandbox).",
    );
    return;
  }
  if (!isStalled(state, now)) {
    log.warn(`channel ${topic}: ${status}${detail}`);
    return;
  }
  if (state.escalated) return;
  state.escalated = true;
  // Two remedies, and naming the wrong one sends a reader to the wrong place:
  // a channel that has NEVER joined is almost always authority (the filtered
  // subscribe is rejected server-side), while one that joined and dropped is
  // connectivity. Same escalation, different sentence.
  const consequence =
    "Changes on this channel are NOT being delivered: sandboxes will not be invalidated " +
    "on redeploy and studio SSE will not push.";
  log.error(
    state.everJoined
      ? `channel ${topic} has been DOWN for ${secondsSince(state.since, now)}s after ` +
          `${state.outages} outage(s) and is retrying indefinitely${detail}. ${consequence} ` +
          "It joined before, so this is connectivity rather than authority."
      : `channel ${topic} has never joined after ${Math.round(JOIN_BUDGET_MS / 1000)}s ` +
          `and is retrying indefinitely${detail}. ${consequence} ` +
          "Check SUPABASE_SERVICE_ROLE_KEY's authority and the aai_platform grants.",
  );
}

/**
 * One acked join. A REjoin says so, with the gap it covered — see
 * {@link ChannelState} on why a silent recovery is not good enough.
 */
function reportJoin(topic: string, state: ChannelState): void {
  const now = Date.now();
  if (state.everJoined && !state.up) {
    log.warn(
      `channel ${topic} REJOINED after ${secondsSince(state.since, now)}s down ` +
        `(outage ${state.outages}). Watchers re-read on the join, so residents reconcile — ` +
        "but any change during the gap was delivered to nobody.",
    );
  }
  state.up = true;
  state.everJoined = true;
  state.escalated = false;
  state.since = now;
}

export function createSubscriptionMonitor() {
  const channels = new Map<string, ChannelState>();

  return {
    /**
     * Register `topic` and return its subscribe callback. Re-registering a
     * topic (a channel released and re-claimed) restarts its budget, which is
     * correct — it is a new join attempt, not a continuing one.
     */
    track(topic: string): (status: string, err?: Error) => void {
      const state: ChannelState = {
        since: Date.now(),
        up: false,
        everJoined: false,
        outages: 0,
        escalated: false,
      };
      channels.set(topic, state);
      return (status, err) => {
        if (status === "SUBSCRIBED") reportJoin(topic, state);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reportFailure(topic, state, status, err);
        }
      };
    },

    /** Forget a channel that has been unsubscribed. */
    untrack(topic: string): void {
      channels.delete(topic);
    },

    health(): PlatformEventsHealth {
      const now = Date.now();
      const stalled: string[] = [];
      for (const [topic, state] of channels) {
        if (isStalled(state, now)) stalled.push(topic);
      }
      return { channels: channels.size, stalled };
    },

    clear(): void {
      channels.clear();
    },
  };
}
