// Copyright 2026 the AAI authors. MIT license.
/**
 * The Supabase Realtime implementation of PlatformEvents, against a fake
 * client — channel topology, filters, signal extraction, refcounting, and
 * the boot-time publication setup's SQL.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createRealtimePlatformEvents,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  realtimeEndpoint,
} from "./realtime-events.ts";

type ChangeHandler = (payload: {
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}) => void;

type FakeChannel = RealtimeChannelLike & {
  topic: string;
  filters: Record<string, unknown>[];
  handlers: ChangeHandler[];
  subscribed: boolean;
  unsubscribed: boolean;
  /**
   * Deliver a subscribe status the way the real join does — ASYNCHRONOUSLY,
   * from the server's ack. Kept a separate step rather than fired inside
   * `subscribe()` because the gap between sending a join and it being live is
   * exactly what a watcher has to survive (see `createChannelPool`).
   */
  ack(status: string, err?: Error): void;
};

function fakeClient() {
  const channels: FakeChannel[] = [];
  const client: RealtimeClientLike = {
    channel(topic) {
      let status: ((value: string, err?: Error) => void) | undefined;
      const channel: FakeChannel = {
        topic,
        filters: [],
        handlers: [],
        subscribed: false,
        unsubscribed: false,
        on(_type, filter, callback) {
          channel.filters.push(filter);
          channel.handlers.push(callback);
          return channel;
        },
        subscribe(callback) {
          channel.subscribed = true;
          status = callback;
          return channel;
        },
        ack(value, err) {
          status?.(value, err);
        },
        unsubscribe() {
          channel.unsubscribed = true;
          return Promise.resolve("ok");
        },
      };
      channels.push(channel);
      return channel;
    },
    disconnect: vi.fn(),
  };
  return { client, channels };
}

test("realtimeEndpoint maps the project URL to the Realtime WebSocket", () => {
  expect(realtimeEndpoint("https://ref.supabase.co")).toBe("wss://ref.supabase.co/realtime/v1");
  expect(realtimeEndpoint("https://ref.supabase.co/")).toBe("wss://ref.supabase.co/realtime/v1");
});

describe("agents channel", () => {
  test("one shared channel; watchers get the slug from new or old rows", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen: string[] = [];
    events.watchAgents((slug) => seen.push(slug));
    events.watchAgents((slug) => seen.push(`b:${slug}`));

    expect(channels).toHaveLength(1);
    const channel = channels[0] as FakeChannel;
    expect(channel.subscribed).toBe(true);
    expect(channel.filters[0]).toEqual({ event: "*", schema: "aai_platform", table: "agents" });

    channel.handlers[0]?.({ new: { slug: "deployed" } });
    channel.handlers[0]?.({ new: null, old: { slug: "deleted" } });
    // Malformed payloads are dropped, never thrown.
    channel.handlers[0]?.({ new: { slug: 42 } as never });
    channel.handlers[0]?.({});

    expect(seen).toEqual(["deployed", "b:deployed", "deleted", "b:deleted"]);
  });

  test("an unwatched handler stops firing", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen = vi.fn();
    const unwatch = events.watchAgents(seen);
    unwatch();
    channels[0]?.handlers[0]?.({ new: { slug: "s" } });
    expect(seen).not.toHaveBeenCalled();
  });

  /**
   * The gap that makes this channel's join signal matter MORE than the pooled
   * channels' — where a missed change costs a stale studio pane until the next
   * edit. This stream is the only thing that moves resident sandboxes (no
   * per-broker version check, no idle-sweep superseded probe), so a deploy
   * landing during a socket drop reaches nobody and nothing later notices: the
   * replica serves superseded code, and answers for a deleted agent, while the
   * deploy reports success.
   */
  test("a join fires the resync watchers, so changes missed before it are re-checked", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const onChange = vi.fn();
    const onResync = vi.fn();
    events.watchAgents(onChange, onResync);
    const channel = channels[0] as FakeChannel;

    // Nothing yet — the join is still in flight, which is the whole gap.
    expect(onResync).not.toHaveBeenCalled();
    channel.ack("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledOnce();

    // Every REjoin too: a socket drop loses every change during the outage.
    channel.ack("SUBSCRIBED");
    expect(onResync).toHaveBeenCalledTimes(2);

    // A failed join is not a delivery point, so it must not fire.
    channel.ack("CHANNEL_ERROR", new Error("nope"));
    expect(onResync).toHaveBeenCalledTimes(2);

    // A resync is not a change: it carries no slug and must not be mistaken
    // for one by a handler that only registered `onChange`.
    expect(onChange).not.toHaveBeenCalled();
  });

  test("the join fires the resync watcher that triggered it, not just later ones", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    // A synchronous ack is legal (a fake, a same-tick reconnect), so the first
    // watcher must already be registered when subscribe() is called — it is
    // the one whose subscription the join is making real. Registering after
    // `ensureAgentsChannel()` would drop exactly that first signal.
    const first = vi.fn();
    events.watchAgents(vi.fn(), first);
    (channels[0] as FakeChannel).ack("SUBSCRIBED");
    expect(first).toHaveBeenCalledOnce();

    const late = vi.fn();
    events.watchAgents(vi.fn(), late);
    expect(channels).toHaveLength(1);
    (channels[0] as FakeChannel).ack("SUBSCRIBED");
    expect(late).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledTimes(2);
  });

  test("unwatching drops the resync watcher with its change watcher", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const onResync = vi.fn();
    events.watchAgents(vi.fn(), onResync)();
    (channels[0] as FakeChannel).ack("SUBSCRIBED");
    expect(onResync).not.toHaveBeenCalled();
  });

  test("a watcher registered without a resync handler still joins cleanly", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const onChange = vi.fn();
    events.watchAgents(onChange);
    expect(() => (channels[0] as FakeChannel).ack("SUBSCRIBED")).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("workspace channels", () => {
  test("filters by project, checks scope handler-side", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen = vi.fn();
    events.watchWorkspace("scope-a", "proj", seen);

    const channel = channels[0] as FakeChannel;
    expect(channel.filters[0]).toEqual({
      event: "*",
      schema: "aai_platform",
      table: "studio_workspaces",
      filter: "project=eq.proj",
    });

    // Same project name under ANOTHER caller's scope must not leak through.
    channel.handlers[0]?.({ new: { scope: "scope-b", project: "proj" } });
    expect(seen).not.toHaveBeenCalled();
    channel.handlers[0]?.({ new: { scope: "scope-a", project: "proj" } });
    expect(seen).toHaveBeenCalledOnce();
  });

  test("watchers of one project share a channel; the last unwatch releases it", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const unwatchA = events.watchWorkspace("s", "p", vi.fn());
    const unwatchB = events.watchWorkspace("s", "p", vi.fn());
    expect(channels).toHaveLength(1);

    unwatchA();
    expect(channels[0]?.unsubscribed).toBe(false);
    unwatchB();
    expect(channels[0]?.unsubscribed).toBe(true);

    // A fresh watch after release builds a fresh channel.
    events.watchWorkspace("s", "p", vi.fn());
    expect(channels).toHaveLength(2);
  });

  test("distinct projects get distinct channels", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p1", vi.fn());
    events.watchWorkspace("s", "p2", vi.fn());
    expect(channels).toHaveLength(2);
  });

  test("chat watches stream studio_chats, scope-checked like workspaces", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen = vi.fn();
    events.watchChat("scope-a", "proj", seen);
    const channel = channels[0] as FakeChannel;
    expect(channel.filters[0]).toEqual({
      event: "*",
      schema: "aai_platform",
      table: "studio_chats",
      filter: "project=eq.proj",
    });
    channel.handlers[0]?.({ new: { scope: "scope-b", project: "proj" } });
    expect(seen).not.toHaveBeenCalled();
    channel.handlers[0]?.({ new: { scope: "scope-a", project: "proj" } });
    expect(seen).toHaveBeenCalledOnce();
  });

  test("scope watches stream all of the scope's workspace rows", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen = vi.fn();
    events.watchScopeProjects("scope-a", seen);
    const channel = channels[0] as FakeChannel;
    expect(channel.filters[0]).toEqual({
      event: "*",
      schema: "aai_platform",
      table: "studio_workspaces",
      filter: "scope=eq.scope-a",
    });
    // Deletes only carry the old row; the watcher must still hear them.
    channel.handlers[0]?.({ new: null, old: { scope: "scope-a", project: "gone" } });
    channel.handlers[0]?.({ new: { scope: "scope-a", project: "fresh" } });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  /**
   * A (re)join is a signal in its own right. `subscribe()` only SENDS the
   * join — the server-side postgres_changes binding does not exist until the
   * ack — and realtime-js rejoins after any socket drop, so changes in either
   * window reach nobody and there is no sequence number to resume from. Since
   * the studio client's polling loop was removed, nothing else would ever
   * notice: the pane just holds a stale snapshot indefinitely. Firing watchers
   * on the ack turns both windows into a redundant re-read.
   */
  test("a join fires watchers, so changes missed before it are re-read", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const seen = vi.fn();
    events.watchWorkspace("s", "p", seen);
    const channel = channels[0] as FakeChannel;

    // Nothing yet — the join is still in flight, which is the whole gap.
    expect(seen).not.toHaveBeenCalled();
    channel.ack("SUBSCRIBED");
    expect(seen).toHaveBeenCalledOnce();

    // Every REjoin too: a socket drop loses every change during the outage.
    channel.ack("SUBSCRIBED");
    expect(seen).toHaveBeenCalledTimes(2);
    // A failed join is not a delivery point, so it must not fire.
    channel.ack("CHANNEL_ERROR", new Error("nope"));
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test("the join fires the watcher that triggered it, not just later ones", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    // A synchronous ack is legal (a fake, a same-tick reconnect), so the
    // first watcher must already be registered when subscribe() is called —
    // it is the one whose subscription the join is making real.
    const seen = vi.fn();
    events.watchWorkspace("s", "p", seen);
    (channels[0] as FakeChannel).ack("SUBSCRIBED");
    expect(seen).toHaveBeenCalledOnce();

    // A watcher joining an ALREADY-subscribed channel shares its signals.
    const late = vi.fn();
    events.watchWorkspace("s", "p", late);
    expect(channels).toHaveLength(1);
    (channels[0] as FakeChannel).ack("SUBSCRIBED");
    expect(late).toHaveBeenCalledOnce();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test("a watcher may unwatch from inside its own callback", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const other = vi.fn();
    let unwatch = (): void => undefined;
    const selfRemoving = vi.fn(() => unwatch());
    unwatch = events.watchWorkspace("s", "p", selfRemoving);
    events.watchWorkspace("s", "p", other);

    // Dispatch iterates a snapshot, so mutating the set mid-fire cannot
    // decide who runs by insertion order.
    (channels[0] as FakeChannel).handlers[0]?.({ new: { scope: "s", project: "p" } });
    expect(selfRemoving).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(channels[0]?.unsubscribed).toBe(false);
  });

  test("close unsubscribes workspace channels and disconnects", async () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    await events.close();
    expect(channels[0]?.unsubscribed).toBe(true);
    expect(client.disconnect).toHaveBeenCalled();
  });
});

/**
 * The failure these cover has happened twice in production and produced no
 * symptom either time: a subscribe that can never succeed leaves realtime-js
 * retrying the join forever, so the service boots healthy, every request
 * succeeds, and the platform merely stops invalidating sandboxes and pushing
 * SSE. The only trace was a `console.warn` per retry.
 */
describe("subscription health", () => {
  test("a channel that acks its join is healthy, and reports as one", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    (channels[0] as FakeChannel).ack("SUBSCRIBED");

    expect(events.health()).toEqual({ channels: 1, stalled: [] });
  });

  test("a channel that never joins is stalled once its budget lapses", () => {
    const { client, channels } = fakeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    const channel = channels[0] as FakeChannel;

    // Inside the budget a failure is ordinary — a deploy, a blip — and warns.
    channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));
    expect(events.health().stalled).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60_000);
      channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));
      channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));

      expect(events.health()).toEqual({ channels: 1, stalled: ["aai:workspace:s:p"] });
      // Escalated ONCE, however many times it retries — the point is to be
      // findable in a log, not to become the log.
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]?.[0]).toContain("never joined");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a joined channel stays healthy however long it runs", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchAgents(vi.fn());
    (channels[0] as FakeChannel).ack("SUBSCRIBED");

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60_000);
      expect(events.health().stalled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("releasing the last watcher stops counting the channel", () => {
    const { client } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const unwatch = events.watchWorkspace("s", "p", vi.fn());
    expect(events.health().channels).toBe(1);
    unwatch();
    expect(events.health()).toEqual({ channels: 0, stalled: [] });
  });
});
