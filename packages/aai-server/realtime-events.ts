// Copyright 2026 the AAI authors. MIT license.
/**
 * Supabase Realtime implementation of {@link PlatformEvents}.
 *
 * One `RealtimeClient` per process, multiplexing channels over a single
 * WebSocket to the platform Supabase project's Realtime endpoint
 * (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — server-side only; the
 * service key never reaches a browser, which is why the studio client gets
 * its pushes relayed over the platform's own SSE routes instead of
 * subscribing here directly).
 *
 * Events are `postgres_changes` streams on the same rows every replica
 * already treats as the source of truth:
 *
 * - `aai_platform.agents` (one unfiltered channel) — a deploy's row upsert
 *   or a delete IS the notification; there is no separate "send" step a
 *   mutation path could forget, which is the same reasoning that put the
 *   deploy version on the agents row in the first place (see
 *   agent-store.ts). This is also why postgres_changes was chosen over a
 *   Realtime broadcast: a broadcast is a second code path per mutation.
 * - `aai_platform.studio_workspaces` — per watched project (filtered
 *   `project=eq.<name>`) for the project SSE stream, and per watched scope
 *   (filtered `scope=eq.<hash>`) for the home sidebar's project list. The
 *   postgres filter carries one column, so the other half of the composite
 *   key is checked handler-side.
 * - `aai_platform.studio_chats` — per watched project, for pushing settled
 *   chat turns to other tabs/devices.
 *
 * Handlers receive SIGNALS, not payloads: watchers re-read the row (see
 * platform-events.ts). That makes delivery semantics forgiving — a
 * duplicated event re-reads, a reconnect resubscribes, and Realtime's
 * payload cap can never truncate anything we depend on.
 *
 * The DATABASE side of this — the watched tables' membership in the
 * `supabase_realtime` publication, and the `service_role` SELECT grants that
 * make a filtered subscribe legal — lives in
 * `supabase/migrations/*_platform_schema.sql`. It used to be a boot-time
 * `ensureRealtimeSetup` that also created the tables, because the stores
 * created them lazily on first use, which is too late for a fresh project's
 * boot. With the schema declared in migrations there is nothing to ensure:
 * the publication and grants are applied before any code runs.
 *
 * Both halves of that grant are load-bearing. Realtime validates a channel's
 * `filter` column — and walrus gates row visibility — against the columns the
 * subscriber's claimed role can SELECT, and this client authenticates with
 * the service-role key. The `aai_platform` schema is app-created, so
 * Supabase's default `public` grants never cover it; without the explicit
 * grant every filtered subscribe fails server-side with `invalid column for
 * filter <col>` (P0001) on the `realtime.subscription` insert, and
 * realtime-js retries the join forever.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import { RealtimeClient } from "@supabase/realtime-js";
import {
  type PlatformEvents,
  type PlatformEventsHealth,
  projectKey,
  type Unwatch,
} from "./platform-events.ts";

/** The rows a postgres_changes payload carries. Treated as untrusted wire data. */
type ChangePayload = {
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
};

type PostgresChangesFilter = {
  event: "*";
  schema: string;
  table: string;
  filter?: string;
};

/**
 * The slice of `RealtimeChannel` this module uses — structural, so tests
 * inject a fake instead of a live socket.
 */
export type RealtimeChannelLike = {
  on(
    type: "postgres_changes",
    filter: PostgresChangesFilter,
    callback: (payload: ChangePayload) => void,
  ): unknown;
  subscribe(callback?: (status: string, err?: Error) => void): unknown;
  unsubscribe(): Promise<unknown>;
};

export type RealtimeClientLike = {
  channel(topic: string): RealtimeChannelLike;
  disconnect(): void;
};

export type RealtimePlatformEventsOptions = {
  /** The Supabase project URL (`https://<ref>.supabase.co`). */
  url: string;
  /** Service-role key — Realtime authorization for the platform schema. */
  key: string;
  /** Test seam: inject a fake client instead of dialing Supabase. */
  client?: RealtimeClientLike;
};

/** `https://<ref>.supabase.co` → the project's Realtime WebSocket endpoint. */
export function realtimeEndpoint(url: string): string {
  return `${url.replace(/\/+$/, "").replace(/^http/, "ws")}/realtime/v1`;
}

function defaultClient(opts: RealtimePlatformEventsOptions): RealtimeClientLike {
  return new RealtimeClient(realtimeEndpoint(opts.url), {
    params: { apikey: opts.key },
  }) as unknown as RealtimeClientLike;
}

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
 * a wedged channel and a healthy one used to be the rate of a `console.warn`.
 * That is invisible in two directions at once — nobody watches for a warn, and
 * a warn per retry is indistinguishable from a warn per blip.
 *
 * So failures are counted per channel instead of narrated: an ordinary
 * failure still warns, a channel that has never joined and is past the budget
 * escalates ONCE to `console.error`, and {@link health} reports it for as long
 * as it lasts.
 */
type ChannelState = { openedAt: number; joined: boolean; escalated: boolean };

/** Never joined, and out of budget. */
function isStalled(state: ChannelState, now: number): boolean {
  return !state.joined && now - state.openedAt >= JOIN_BUDGET_MS;
}

/**
 * One failed join: ordinary until the budget lapses, then escalated ONCE.
 * Once, because the retry is infinite — a per-retry error would become the log
 * rather than a finding in it.
 */
function reportFailure(
  topic: string,
  state: ChannelState,
  status: string,
  err: Error | undefined,
): void {
  const detail = err ? ` (${errorMessage(err)})` : "";
  if (!isStalled(state, Date.now())) {
    console.warn(`Realtime channel ${topic}: ${status}${detail}`);
    return;
  }
  if (state.escalated) return;
  state.escalated = true;
  console.error(
    `Realtime channel ${topic} has never joined after ${Math.round(JOIN_BUDGET_MS / 1000)}s ` +
      `and is retrying indefinitely${detail}. Changes on this channel are NOT being ` +
      "delivered: sandboxes will not be invalidated on redeploy and studio SSE will not " +
      "push. Check SUPABASE_SERVICE_ROLE_KEY's authority and the aai_platform grants.",
  );
}

function createSubscriptionMonitor() {
  const channels = new Map<string, ChannelState>();

  return {
    /**
     * Register `topic` and return its subscribe callback. Re-registering a
     * topic (a channel released and re-claimed) restarts its budget, which is
     * correct — it is a new join attempt, not a continuing one.
     */
    track(topic: string): (status: string, err?: Error) => void {
      const state: ChannelState = { openedAt: Date.now(), joined: false, escalated: false };
      channels.set(topic, state);
      return (status, err) => {
        if (status === "SUBSCRIBED") state.joined = true;
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

/**
 * Refcounted keyed channels: one Realtime channel per distinct key, shared
 * by its watchers and released (unsubscribed) when the last one unwatches.
 * Entries are dropped by identity — the pool is an {@link createOwnedMap}, so
 * a late unwatch releases its own claim and can never tear down a successor
 * channel for the same key.
 *
 * **A (re)join is itself a signal.** `subscribe()` only SENDS the join; the
 * server-side `postgres_changes` binding does not exist until the push is
 * acked with `SUBSCRIBED`, and realtime-js rejoins the channel after any
 * socket drop. Changes in either window are delivered to nobody, ever — these
 * are pure signal streams with no sequence number to resume from and (since
 * the studio client's polling loop was removed) nothing downstream that would
 * notice. So every successful join fires the key's watchers, which re-read
 * their row exactly as they do for a change event. That makes the join gap and
 * a reconnect outage cost a redundant read instead of a silently stale client.
 */
function createChannelPool(
  client: RealtimeClientLike,
  monitor: ReturnType<typeof createSubscriptionMonitor>,
) {
  type Entry = {
    channel: RealtimeChannelLike;
    watchers: Set<() => void>;
    /** This entry's claim on its key; a no-op once a successor has claimed it. */
    release?: () => boolean;
  };
  const entries = createOwnedMap<string, Entry>();

  return {
    watch(
      key: string,
      topic: string,
      filter: PostgresChangesFilter,
      accepts: (row: Record<string, unknown> | null | undefined) => boolean,
      onChange: () => void,
    ): Unwatch {
      const existing = entries.get(key);
      // Register the watcher BEFORE any subscribe, so the join signal below
      // cannot land ahead of the watcher that triggered the join. It is the
      // one that most needs it — the join is what makes its subscription real.
      const created: Entry = existing ?? { channel: client.channel(topic), watchers: new Set() };
      const current = created;
      current.watchers.add(onChange);
      if (!existing) {
        current.release = entries.claim(key, current);
        // Snapshot before dispatch: a watcher is free to unwatch (or another
        // watcher may subscribe) from inside its own callback, and mutating
        // the set mid-iteration decides who runs by insertion order.
        const fire = (): void => {
          for (const watcher of [...current.watchers]) watcher();
        };
        current.channel.on("postgres_changes", filter, (payload) => {
          if (!accepts(payload.new ?? payload.old)) return;
          fire();
        });
        const onStatus = monitor.track(topic);
        current.channel.subscribe((status, err) => {
          onStatus(status, err);
          // See the note above: the join is the point from which changes are
          // delivered, so it is also the point at which watchers owe
          // themselves a re-read.
          if (status === "SUBSCRIBED") fire();
        });
      }
      return () => {
        current.watchers.delete(onChange);
        if (current.watchers.size > 0) return;
        current.release?.();
        monitor.untrack(topic);
        void current.channel.unsubscribe().catch(() => undefined);
      };
    },
    close(): void {
      for (const entry of entries.values()) {
        void entry.channel.unsubscribe().catch(() => undefined);
      }
      entries.clear();
    },
  };
}

export function createRealtimePlatformEvents(opts: RealtimePlatformEventsOptions): PlatformEvents {
  const client = opts.client ?? defaultClient(opts);

  // The one agents channel, shared by every watcher, created on first watch.
  const agentWatchers = new Set<(slug: string) => void>();
  const agentResyncWatchers = new Set<() => void>();
  let agentsChannel: RealtimeChannelLike | null = null;

  const ensureAgentsChannel = (): void => {
    if (agentsChannel) return;
    agentsChannel = client.channel("aai:agents");
    agentsChannel.on(
      "postgres_changes",
      { event: "*", schema: "aai_platform", table: "agents" },
      (payload) => {
        // Delete events carry the identity in `old`; everything else in `new`.
        const slug = payload.new?.slug ?? payload.old?.slug;
        if (typeof slug !== "string" || slug.length === 0) return;
        // Snapshot: a handler may unwatch from inside its own callback.
        for (const watcher of [...agentWatchers]) watcher(slug);
      },
    );
    const onStatus = monitor.track("aai:agents");
    agentsChannel.subscribe((status, err) => {
      onStatus(status, err);
      // **A (re)join is a signal on THIS channel too** — the same rule
      // `createChannelPool` documents, and for a long time the pooled channels
      // were the only ones that honoured it. The gap is worse here, not
      // better: this stream is the SINGLE mover of resident sandboxes (the
      // per-broker version check and the idle sweep's superseded probe were
      // both deleted when it took the job), so a change that lands between a
      // socket drop and the rejoin is delivered to nobody and NOTHING else
      // will ever notice. The replica keeps serving superseded code, and keeps
      // answering for a deleted agent, until its guest happens to self-exit on
      // idle — which for a busy agent is never, because traffic is what keeps
      // it non-idle. The deploy that caused it reported success.
      //
      // The monitor beside this makes such a channel VISIBLE once it is
      // stalled; it cannot repair one that recovered on its own, which is the
      // common case and the silent one.
      if (status === "SUBSCRIBED") {
        // Snapshot: a handler may unwatch from inside its own callback.
        for (const watcher of [...agentResyncWatchers]) watcher();
      }
    });
  };

  const monitor = createSubscriptionMonitor();
  const pool = createChannelPool(client, monitor);
  const scopeAccepts = (scope: string) => (row: Record<string, unknown> | null | undefined) =>
    row?.scope === scope;

  return {
    watchAgents(onChange, onResync): Unwatch {
      // Registered BEFORE the channel is ensured, so the join this call may
      // trigger cannot fire ahead of the watcher that triggered it — the same
      // ordering `createChannelPool.watch` keeps, and now load-bearing here
      // for the same reason: the join IS `onResync`'s first delivery.
      agentWatchers.add(onChange);
      if (onResync) agentResyncWatchers.add(onResync);
      ensureAgentsChannel();
      return () => {
        agentWatchers.delete(onChange);
        if (onResync) agentResyncWatchers.delete(onResync);
      };
    },

    watchWorkspace(scope, project, onChange): Unwatch {
      return pool.watch(
        `ws:${projectKey(scope, project)}`,
        `aai:workspace:${scope}:${project}`,
        {
          event: "*",
          schema: "aai_platform",
          table: "studio_workspaces",
          filter: `project=eq.${project}`,
        },
        scopeAccepts(scope),
        onChange,
      );
    },

    watchChat(scope, project, onChange): Unwatch {
      return pool.watch(
        `chat:${projectKey(scope, project)}`,
        `aai:chat:${scope}:${project}`,
        {
          event: "*",
          schema: "aai_platform",
          table: "studio_chats",
          filter: `project=eq.${project}`,
        },
        scopeAccepts(scope),
        onChange,
      );
    },

    watchScopeProjects(scope, onChange): Unwatch {
      return pool.watch(
        `scope:${scope}`,
        `aai:projects:${scope}`,
        {
          event: "*",
          schema: "aai_platform",
          table: "studio_workspaces",
          filter: `scope=eq.${scope}`,
        },
        // The filter already narrows to the scope; every row qualifies.
        () => true,
        onChange,
      );
    },

    health: () => monitor.health(),

    close() {
      pool.close();
      // Both watcher sets, and the channel itself. `watchAgents` writes to
      // both sets, so clearing one was an asymmetry with two consequences:
      // the resync handlers stayed reachable after close, and — because
      // `ensureAgentsChannel` short-circuits on a non-null `agentsChannel` —
      // a `watchAgents` after close installed a watcher onto a channel that
      // would never be subscribed again, silently. The pooled channels have
      // always been unsubscribed here; this one was left to `disconnect()`.
      agentWatchers.clear();
      agentResyncWatchers.clear();
      void agentsChannel?.unsubscribe().catch(() => undefined);
      agentsChannel = null;
      monitor.clear();
      client.disconnect();
      return Promise.resolve();
    },
  };
}
