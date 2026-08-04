// Copyright 2026 the AAI authors. MIT license.
/**
 * The Supabase Realtime implementation of PlatformEvents, against a fake
 * client — channel topology, filters, signal extraction, refcounting, and
 * the boot-time publication setup's SQL.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createRealtimePlatformEvents,
  ensureRealtimeSetup,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  realtimeEndpoint,
} from "./realtime-events.ts";
import type { SqlExec } from "./secret-store.ts";

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
};

function fakeClient() {
  const channels: FakeChannel[] = [];
  const client: RealtimeClientLike = {
    channel(topic) {
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
          callback?.("SUBSCRIBED");
          return channel;
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

  test("close unsubscribes workspace channels and disconnects", async () => {
    const { client, channels } = fakeClient();
    const events = createRealtimePlatformEvents({ url: "https://x", key: "k", client });
    events.watchWorkspace("s", "p", vi.fn());
    await events.close();
    expect(channels[0]?.unsubscribed).toBe(true);
    expect(client.disconnect).toHaveBeenCalled();
  });
});

test("ensureRealtimeSetup creates the tables, the publication, then the grants", async () => {
  const statements: string[] = [];
  const sql: SqlExec = (query) => {
    statements.push(query);
    return Promise.resolve([]);
  };
  await ensureRealtimeSetup(sql);

  expect(statements[0]).toContain("create schema if not exists aai_platform");
  expect(statements[1]).toContain("aai_platform.agents");
  expect(statements[2]).toContain("aai_platform.studio_workspaces");
  expect(statements[3]).toContain("aai_platform.studio_chats");
  const publication = statements[4];
  // Every watched table is added to the publication.
  for (const table of ["agents", "studio_workspaces", "studio_chats"]) {
    expect(publication).toContain(
      `alter publication supabase_realtime add table aai_platform.${table}`,
    );
  }
  // Realtime validates channel filters against the columns the subscriber's
  // claimed role (service_role — the key the client connects with) can
  // SELECT, so every watched table needs the grant or filtered subscribes
  // fail with `invalid column for filter <col>`.
  const grants = statements[5];
  expect(grants).toContain("rolname = 'service_role'");
  expect(grants).toContain("grant usage on schema aai_platform to service_role");
  expect(grants).toContain(
    "grant select on aai_platform.agents, aai_platform.studio_workspaces, aai_platform.studio_chats",
  );
});
