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
