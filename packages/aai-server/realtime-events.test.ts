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
import { captureLogs } from "./test-utils.ts";

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
  // Silenced, not asserted: a drop after a successful join now WARNS (see
  // "subscription health"), and several specs here ack a CHANNEL_ERROR to drive
  // the reconnect path.
  captureLogs();

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
  // Silenced, not asserted: a drop after a successful join now WARNS (see
  // "subscription health"), and several specs here ack a CHANNEL_ERROR to drive
  // the reconnect path.
  captureLogs();

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

  test("no (scope, project) pair can forge another's TOPIC either", () => {
    // The pool key went through `projectKey` while the topic was built with a
    // `:` both halves may contain — so these two pairs produced two pool
    // entries and ONE topic. The subscription monitor is keyed on the topic, so
    // the second `track` clobbered the first's state and either `untrack`
    // dropped what was left: a stalled channel invisible to `/health`.
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("a:b", "c", vi.fn());
    events.watchWorkspace("a", "b:c", vi.fn());
    expect(channels).toHaveLength(2);
    expect(channels[0]?.topic).not.toBe(channels[1]?.topic);
  });

  test("no (scope, project) pair can forge another's pool key", () => {
    // The pool keyed on `ws:${scope} ${project}` — a SPACE — while the
    // separator's whole argument (see projectKey in platform-events.ts) is
    // that no pair can spell another's key. Under a printable separator these
    // two pairs collide, and the second watcher silently joins the FIRST
    // pair's channel: it would then receive the other project's events and
    // none of its own. Today's grammars exclude a space from both halves, so
    // this is the drift guard rather than a live bug.
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("a b", "c", vi.fn());
    events.watchWorkspace("a", "b c", vi.fn());
    expect(channels).toHaveLength(2);
    expect(channels[0]?.topic).not.toBe(channels[1]?.topic);
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

  test("close unsubscribes the agents channel too, not just the pooled ones", async () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchAgents(vi.fn());
    await events.close();
    expect(channels[0]?.topic).toBe("aai:agents");
    expect(channels[0]?.unsubscribed).toBe(true);
  });

  test("close drops the resync watchers with the change watchers", async () => {
    // `watchAgents` writes to both sets; clearing one left the resync
    // handlers reachable by a rejoin on a channel nothing had released.
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    const onChange = vi.fn();
    const onResync = vi.fn();
    events.watchAgents(onChange, onResync);
    await events.close();

    channels[0]?.ack("SUBSCRIBED");
    channels[0]?.handlers[0]?.({ new: { slug: "a" } });

    expect(onResync).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a watch after close builds a fresh, subscribed agents channel", async () => {
    // `ensureAgentsChannel` short-circuits on a non-null handle, so leaving
    // the closed channel in place made a later watch silently inert — the
    // watcher installed onto a channel that would never be subscribed again.
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchAgents(vi.fn());
    await events.close();

    const onChange = vi.fn();
    events.watchAgents(onChange);

    expect(channels).toHaveLength(2);
    expect(channels[1]?.subscribed).toBe(true);
    channels[1]?.handlers[0]?.({ new: { slug: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
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
  const logs = captureLogs();

  test("a channel that acks its join is healthy, and reports as one", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    (channels[0] as FakeChannel).ack("SUBSCRIBED");

    expect(events.health()).toEqual({ channels: 1, stalled: [] });
  });

  test("a channel that never joins is stalled once its budget lapses", () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    const channel = channels[0] as FakeChannel;

    // Inside the budget a failure is ordinary — a deploy, a blip — and warns.
    channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));
    expect(events.health().stalled).toEqual([]);
    expect(logs.warns()).toHaveLength(1);
    expect(logs.errors()).toEqual([]);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60_000);
      channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));
      channel.ack("CHANNEL_ERROR", new Error("invalid column for filter project"));

      expect(events.health()).toEqual({ channels: 1, stalled: ["aai:workspace:s:p"] });
      // Escalated ONCE, however many times it retries — the point is to be
      // findable in a log, not to become the log.
      expect(logs.errors()).toEqual([expect.stringContaining("never joined")]);
      expect(logs.warns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a channel that JOINED and then dropped is stalled too, and escalates", () => {
    // The gap this closes. `joined` was a high-water mark, so one successful
    // join made a channel permanently healthy: a socket that dropped hours later
    // and never came back printed one indistinguishable warn per retry, was
    // absent from `health().stalled`, and could never reach the escalation —
    // which required `!joined`. It is the WORSE outage of the two, because
    // changes were being delivered and then stopped.
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchAgents(vi.fn());
    const channel = channels[0] as FakeChannel;
    channel.ack("SUBSCRIBED");
    expect(events.health().stalled).toEqual([]);

    vi.useFakeTimers();
    try {
      // The drop itself is a warn naming the consequence, not a bare status.
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      expect(logs.warns()).toEqual([expect.stringContaining("DROPPED")]);
      expect(events.health().stalled).toEqual([]);

      vi.advanceTimersByTime(60_000);
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));

      expect(events.health()).toEqual({ channels: 1, stalled: ["aai:agents"] });
      // Escalated once, and it says CONNECTIVITY — a channel that joined before
      // is not an authority problem, and naming the wrong remedy sends a reader
      // to the grants when the socket is the fault.
      expect(logs.errors()).toEqual([expect.stringContaining("DOWN for")]);
      expect(logs.errors()[0]).toContain("connectivity rather than authority");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a REJOIN says how long the gap was, and clears the escalation", () => {
    // Recovery was silent. The rejoin already repairs the data — every join
    // fires the watchers — but nothing said a gap had happened, and a deploy
    // inside one leaves a replica serving superseded code with nothing else to
    // notice. A second outage escalates again rather than being swallowed by
    // the first one's "once".
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchAgents(vi.fn());
    const channel = channels[0] as FakeChannel;
    channel.ack("SUBSCRIBED");

    vi.useFakeTimers();
    try {
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      vi.advanceTimersByTime(45_000);
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      expect(logs.errors()).toHaveLength(1);

      vi.advanceTimersByTime(5000);
      channel.ack("SUBSCRIBED");
      expect(logs.warns()).toContainEqual(expect.stringContaining("REJOINED after 50s down"));
      expect(events.health().stalled).toEqual([]);

      // A SECOND outage is a second finding, not a repeat suppressed by the first.
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      vi.advanceTimersByTime(60_000);
      channel.ack("CHANNEL_ERROR", new Error("transport failure"));
      expect(logs.errors()).toHaveLength(2);
      expect(logs.errors()[1]).toContain("2 outage(s)");
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
