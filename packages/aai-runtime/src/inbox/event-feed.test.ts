// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent } from "@alexkroman1/aai";
import { setSessionClient } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { stampSessionEvent } from "../session-event-stream.ts";
import {
  type ClientEventFeed,
  feedClientEvent,
  feedClientSessionEnd,
  publishClientEventFeed,
} from "./event-feed.ts";

afterEach(() => publishClientEventFeed(undefined));

const event = (body: Parameters<typeof stampSessionEvent>[0]): SessionEvent =>
  stampSessionEvent(body);

describe("the client event feed", () => {
  test("forwards the conversation's events to the session's client, and nothing else", () => {
    const feed = vi.fn<ClientEventFeed>();
    publishClientEventFeed(feed);
    setSessionClient("feed-a", "porch");
    const said = event({ type: "userTranscript.committed", text: "hi" });
    feedClientEvent("feed-a", said);
    feedClientEvent("feed-a", event({ type: "userTranscript.updated", text: "h" }));
    feedClientEvent("feed-a", event({ type: "tool.completed", toolCallId: "t", result: "{}" }));
    feedClientEvent("feed-a", event({ type: "reply.completed" }));
    expect(feed.mock.calls).toEqual([
      ["porch", { type: "session_event", sessionId: "feed-a", event: said }],
      [
        "porch",
        {
          type: "session_event",
          sessionId: "feed-a",
          event: expect.objectContaining({ type: "reply.completed" }),
        },
      ],
    ]);
  });

  test("a session that named no client feeds nobody", () => {
    const feed = vi.fn<ClientEventFeed>();
    publishClientEventFeed(feed);
    feedClientEvent("feed-anonymous", event({ type: "reply.completed" }));
    feedClientSessionEnd("feed-anonymous");
    expect(feed).not.toHaveBeenCalled();
  });

  test("the end of a session is its own frame", () => {
    const feed = vi.fn<ClientEventFeed>();
    publishClientEventFeed(feed);
    setSessionClient("feed-b", "porch");
    feedClientSessionEnd("feed-b");
    expect(feed).toHaveBeenCalledWith("porch", { type: "session_ended", sessionId: "feed-b" });
  });

  test("a feed that throws never reaches the session, and none published is a no-op", () => {
    setSessionClient("feed-c", "porch");
    expect(() => feedClientEvent("feed-c", event({ type: "reply.cancelled" }))).not.toThrow();
    publishClientEventFeed(() => {
      throw new Error("second screen fell over");
    });
    expect(() => feedClientEvent("feed-c", event({ type: "reply.cancelled" }))).not.toThrow();
  });

  test("the slot is on globalThis, so the bundle's copy of this package feeds the server's", async () => {
    const feed = vi.fn<ClientEventFeed>();
    publishClientEventFeed(feed);
    vi.resetModules();
    const other = await import("./event-feed.ts");
    setSessionClient("feed-d", "porch");
    other.feedClientSessionEnd("feed-d");
    expect(feed).toHaveBeenCalledWith("porch", { type: "session_ended", sessionId: "feed-d" });
  });
});
