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
import { RealtimeClient } from "@supabase/realtime-js";
import type { PlatformEvents, Unwatch } from "./platform-events.ts";

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

/** Log-and-continue subscribe callback: a failed channel is a lost push. */
function logSubscribeStatus(topic: string): (status: string, err?: Error) => void {
  return (status, err) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.warn(`Realtime channel ${topic}: ${status}${err ? ` (${errorMessage(err)})` : ""}`);
    }
  };
}

/**
 * Refcounted keyed channels: one Realtime channel per distinct key, shared
 * by its watchers and released (unsubscribed) when the last one unwatches.
 * Entries are dropped by identity so a late unwatch can never tear down a
 * successor channel for the same key.
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
function createChannelPool(client: RealtimeClientLike) {
  type Entry = { channel: RealtimeChannelLike; watchers: Set<() => void> };
  const entries = new Map<string, Entry>();

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
        entries.set(key, current);
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
        const logStatus = logSubscribeStatus(topic);
        current.channel.subscribe((status, err) => {
          logStatus(status, err);
          // See the note above: the join is the point from which changes are
          // delivered, so it is also the point at which watchers owe
          // themselves a re-read.
          if (status === "SUBSCRIBED") fire();
        });
      }
      return () => {
        current.watchers.delete(onChange);
        if (current.watchers.size > 0) return;
        if (entries.get(key) === current) entries.delete(key);
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
    agentsChannel.subscribe(logSubscribeStatus("aai:agents"));
  };

  const pool = createChannelPool(client);
  const scopeAccepts = (scope: string) => (row: Record<string, unknown> | null | undefined) =>
    row?.scope === scope;

  return {
    watchAgents(onChange): Unwatch {
      ensureAgentsChannel();
      agentWatchers.add(onChange);
      return () => agentWatchers.delete(onChange);
    },

    watchWorkspace(scope, project, onChange): Unwatch {
      return pool.watch(
        `ws:${scope} ${project}`,
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
        `chat:${scope} ${project}`,
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

    close() {
      pool.close();
      agentWatchers.clear();
      client.disconnect();
      return Promise.resolve();
    },
  };
}
