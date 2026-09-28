// Copyright 2026 the AAI authors. MIT license.
/**
 * Several holders of one client on `WS /inbox` — a speaker and the browser
 * joined to it — and the live conversation an `?events=1` holder is fed.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { setSessionClient } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  answerNotice as answer,
  connectDevice,
  type InboxCleanups,
  startInbox,
} from "./_client-inbox-test-utils.ts";
import { feedClientEvent, publishClientEventFeed } from "./client-event-feed.ts";
import { type ClientInbox, INBOX_EVENT_BUFFER_LIMIT_BYTES } from "./client-inbox.ts";
import { stampSessionEvent } from "./session-event-stream.ts";

const cleanups: InboxCleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const connect = (url: string, inbox: ClientInbox, extra = "", clientId = "speaker") =>
  connectDevice(cleanups, url, inbox, clientId, extra);

const notice = { id: "run-1", event: "reminder" };

describe("client inbox holders", () => {
  test("different holders of one client coexist, and a notice reaches every one", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=browser-1");
    const sent = inbox.notify("speaker", notice, { ackTimeoutMs: 5000 });
    expect(await speaker.next()).toMatchObject({ type: "notice", id: "run-1" });
    expect(await browser.next()).toMatchObject({ type: "notice", id: "run-1" });
    // The FIRST ack settles it; the other holder's later ack is a no-op.
    answer(browser.ws, "ack", "run-1");
    await expect(sent).resolves.toBe("acked");
    answer(speaker.ws, "ack", "run-1");
    expect(inbox.connected()).toEqual(["speaker"]);
  });

  test("the same holder again replaces; a missing ?holder= is the default one", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const firmware = await connect(url, inbox);
    const old = await connect(url, inbox, "holder=tab");
    const closed = new Promise((resolve) => old.ws.once("close", resolve));
    const fresh = await connect(url, inbox, "holder=tab");
    await closed;
    const reconnect = new Promise((resolve) => firmware.ws.once("close", resolve));
    const firmwareAgain = await connect(url, inbox);
    await reconnect;
    const sent = inbox.notify("speaker", notice, { ackTimeoutMs: 5000 });
    expect(await fresh.next()).toMatchObject({ id: "run-1" });
    expect(await firmwareAgain.next()).toMatchObject({ id: "run-1" });
    answer(firmwareAgain.ws, "ack", "run-1");
    await expect(sent).resolves.toBe("acked");
  });

  test("busy only when EVERY holder is busy; one silent holder makes it no-ack", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=b");
    const allBusy = inbox.notify("speaker", { id: "b1", event: "e" }, { ackTimeoutMs: 5000 });
    await Promise.all([speaker.next(), browser.next()]);
    answer(speaker.ws, "busy", "b1");
    answer(browser.ws, "busy", "b1");
    await expect(allBusy).resolves.toBe("busy");

    const oneSilent = inbox.notify("speaker", { id: "b2", event: "e" }, { ackTimeoutMs: 100 });
    await Promise.all([speaker.next(), browser.next()]);
    answer(speaker.ws, "busy", "b2");
    await expect(oneSilent).resolves.toBe("no-ack");
  });

  test("the per-client queue still holds across holders: one notice in flight", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=b");
    const first = inbox.notify("speaker", { id: "one", event: "e" }, { ackTimeoutMs: 5000 });
    const second = inbox.notify("speaker", { id: "two", event: "e" }, { ackTimeoutMs: 5000 });
    expect(await speaker.next()).toMatchObject({ id: "one" });
    expect(await browser.next()).toMatchObject({ id: "one" });
    await sleep(50);
    expect([speaker.frames, browser.frames]).toEqual([[], []]);
    answer(speaker.ws, "ack", "one");
    expect(await browser.next()).toMatchObject({ id: "two" });
    answer(browser.ws, "ack", "two");
    await expect(Promise.all([first, second])).resolves.toEqual(["acked", "acked"]);
  });

  test("a malformed ?holder= is closed with a reason", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const ws = new WebSocket(`${url}?client=speaker&holder=${encodeURIComponent("a b")}`);
    const [code, reason] = await new Promise<[number, string]>((resolve) =>
      ws.once("close", (c, r) => resolve([c, r.toString()])),
    );
    expect(code).toBe(1008);
    expect(reason).toContain("?holder=");
    expect(inbox.connected()).toEqual([]);
  });
});

describe("the live event feed on /inbox?events=1", () => {
  afterEach(() => publishClientEventFeed(undefined));

  const event = (body: Parameters<typeof stampSessionEvent>[0]): SessionEvent =>
    stampSessionEvent(body);

  test("only an events holder is sent the frames, as { type: session_event, sessionId, event }", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const firmware = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=tab&events=1");
    const committed = event({ type: "user-transcript.committed", text: "what's the weather" });
    inbox.feed("speaker", { type: "session_event", sessionId: "s-1", event: committed });
    expect(await browser.next()).toEqual({
      type: "session_event",
      sessionId: "s-1",
      event: JSON.parse(JSON.stringify(committed)),
    });
    await sleep(30);
    expect(firmware.frames).toEqual([]);
  });

  test("a session bound to the client reaches it through the published feed, results never", async () => {
    const { inbox, url } = await startInbox(cleanups);
    publishClientEventFeed(inbox.feed);
    const browser = await connect(url, inbox, "holder=tab&events=1");
    setSessionClient("feed-session", "speaker");
    feedClientEvent(
      "feed-session",
      event({ type: "tool.completed", toolCallId: "t", result: "x" }),
    );
    feedClientEvent(
      "feed-session",
      event({ type: "tool.called", toolCallId: "t", toolName: "weather", args: { city: "Oslo" } }),
    );
    expect(await browser.next()).toMatchObject({
      type: "session_event",
      sessionId: "feed-session",
      event: { type: "tool.called", toolName: "weather", args: { city: "Oslo" } },
    });
    expect(browser.frames).toEqual([]);
  });

  test("a holder whose socket is backed up past the limit is skipped, not buffered", async () => {
    const { inbox, url } = await startInbox(cleanups);
    const browser = await connect(url, inbox, "holder=tab&events=1");
    const frame = { type: "session_ended", sessionId: "s-2" } as const;
    // Every socket reads as backed up for one feed — the server's is the one asked.
    const spy = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(INBOX_EVENT_BUFFER_LIMIT_BYTES + 1);
    inbox.feed("speaker", frame);
    spy.mockRestore();
    inbox.feed("speaker", { ...frame, sessionId: "s-3" });
    expect(await browser.next()).toEqual({ type: "session_ended", sessionId: "s-3" });
    expect(browser.frames).toEqual([]);
  });
});
