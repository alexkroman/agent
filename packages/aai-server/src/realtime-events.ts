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

import { createOwnedMap } from "@alexkroman1/aai/internal";
import { RealtimeClient } from "@supabase/realtime-js";
import { type PlatformEvents, projectKey, type Unwatch } from "./platform-events.ts";
import { createSubscriptionMonitor } from "./realtime-subscription-monitor.ts";

/** The schema every watched table lives in — see the module doc's grant note. */
const PLATFORM_SCHEMA = "aai_platform";

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
 * One project's pool KEY and its Realtime TOPIC, derived together.
 *
 * They must be injective in the same way, and only one of them was. The key
 * already went through `projectKey` (NUL-separated, so no pair can spell
 * another's); the topic was `aai:<kind>:${scope}:${project}`, where `:` is a
 * character both halves may hold — so `("a:b", "c")` and `("a", "b:c")` produced
 * TWO pool entries and ONE topic. Two channels then existed under one name, and
 * the subscription monitor is keyed on the TOPIC (`track`/`untrack`/`health`),
 * so the second `track` overwrote the first's `ChannelState` and either
 * `untrack` deleted whatever was left — a stalled channel silently invisible to
 * `/health`, which is the exact failure the monitor exists to make loud.
 *
 * The topic percent-encodes each half rather than carrying the NUL: it crosses
 * the wire as a channel name, and `encodeURIComponent` escapes `:` (to `%3A`),
 * which is all injectivity needs here.
 */
function projectChannel(
  kind: "workspace" | "chat",
  scope: string,
  project: string,
): { key: string; topic: string } {
  return {
    key: `${kind}:${projectKey(scope, project)}`,
    topic: `aai:${kind}:${encodeURIComponent(scope)}:${encodeURIComponent(project)}`,
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

  const monitor = createSubscriptionMonitor();
  const pool = createChannelPool(client, monitor);

  // The one agents channel, shared by every watcher, created on first watch.
  const agentWatchers = new Set<(slug: string) => void>();
  const agentResyncWatchers = new Set<() => void>();
  let agentsChannel: RealtimeChannelLike | null = null;

  const ensureAgentsChannel = (): void => {
    if (agentsChannel) return;
    agentsChannel = client.channel("aai:agents");
    agentsChannel.on(
      "postgres_changes",
      { event: "*", schema: PLATFORM_SCHEMA, table: "agents" },
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

  const scopeAccepts = (scope: string) => (row: Record<string, unknown> | null | undefined) =>
    row?.scope === scope;

  /**
   * One project's row watcher: the workspace and chat streams differ only in
   * which table they watch and which channel kind they claim.
   *
   * Both filter on `project` alone — a postgres_changes filter carries ONE
   * column — so both check the other half of the composite key handler-side with
   * `scopeAccepts`. Written twice, that pairing is one edit away from a stream
   * that watches every scope's rows for a project name.
   */
  const watchProjectRow =
    (kind: "workspace" | "chat", table: string) =>
    (scope: string, project: string, onChange: () => void): Unwatch => {
      const { key, topic } = projectChannel(kind, scope, project);
      return pool.watch(
        key,
        topic,
        { event: "*", schema: PLATFORM_SCHEMA, table, filter: `project=eq.${project}` },
        scopeAccepts(scope),
        onChange,
      );
    };

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

    watchWorkspace: watchProjectRow("workspace", "studio_workspaces"),

    watchChat: watchProjectRow("chat", "studio_chats"),

    watchScopeProjects(scope, onChange): Unwatch {
      return pool.watch(
        `scope:${scope}`,
        `aai:projects:${scope}`,
        {
          event: "*",
          schema: PLATFORM_SCHEMA,
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
