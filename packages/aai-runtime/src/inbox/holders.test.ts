// Copyright 2026 the AAI authors. MIT license.
/**
 * Several holders of one client on `WS /inbox` — a speaker and the browser
 * joined to it — and the live conversation an `?events=1` holder is fed.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { setSessionClient } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { stampSessionEvent } from "../session/index.ts";
import {
  answerNotice as answer,
  connectDevice,
  roundTrip,
  startInbox,
} from "./_inbox-test-utils.ts";
import { feedClientEvent, publishClientEventFeed } from "./event-feed.ts";
import { type ClientInbox, INBOX_EVENT_BUFFER_LIMIT_BYTES } from "./inbox.ts";

const connect = (url: string, inbox: ClientInbox, extra = "", clientId = "speaker") =>
  connectDevice(url, inbox, clientId, extra);

const notice = { id: "run-1", event: "reminder" };

describe("client inbox holders", () => {
  test("different holders of one client coexist, and a notice reaches every one", async () => {
    const { inbox, url } = await startInbox();
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=browser-1");
    const sent = inbox.notify("speaker", notice, { ackTimeoutMs: 5000 });
    expect(await speaker.next()).toMatchObject({ type: "notice", id: "run-1" });
    expect(await browser.next()).toMatchObject({ type: "notice", id: "run-1" });
    // Settled once EVERY holder has answered, not on the first ack.
    answer(browser.ws, "ack", "run-1");
    answer(speaker.ws, "ack", "run-1");
    await expect(sent).resolves.toBe("acked");
    expect(inbox.connected()).toEqual(["speaker"]);
  });

  test("the same holder again replaces; a missing ?holder= is the default one", async () => {
    const { inbox, url } = await startInbox();
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
    answer(fresh.ws, "ack", "run-1");
    answer(firmwareAgain.ws, "ack", "run-1");
    await expect(sent).resolves.toBe("acked");
  });

  test("one busy holder makes it busy, so the step brings it back to that holder", async () => {
    // Live case: a page linked to a speaker was mid-conversation when a call's result
    // came in and answered busy; the idle speaker acked. Settled "acked" on that first
    // ack, the page never heard it. Busy wins, the retry re-sends, and the holder that
    // already played it acks the repeat (it drops a notice id it has seen).
    const { inbox, url } = await startInbox();
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=b");
    const first = inbox.notify("speaker", { id: "b1", event: "e" }, { ackTimeoutMs: 5000 });
    await Promise.all([speaker.next(), browser.next()]);
    answer(speaker.ws, "ack", "b1");
    answer(browser.ws, "busy", "b1");
    await expect(first).resolves.toBe("busy");

    const again = inbox.notify("speaker", { id: "b1", event: "e" }, { ackTimeoutMs: 5000 });
    await Promise.all([speaker.next(), browser.next()]);
    answer(speaker.ws, "ack", "b1");
    answer(browser.ws, "ack", "b1");
    await expect(again).resolves.toBe("acked");
  });

  test("acked when one acks and another stays silent; no-ack when all stay silent", async () => {
    const { inbox, url } = await startInbox();
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=b");
    const oneSilent = inbox.notify("speaker", { id: "s1", event: "e" }, { ackTimeoutMs: 100 });
    await Promise.all([speaker.next(), browser.next()]);
    answer(speaker.ws, "ack", "s1");
    await expect(oneSilent).resolves.toBe("acked");

    const allSilent = inbox.notify("speaker", { id: "s2", event: "e" }, { ackTimeoutMs: 100 });
    await Promise.all([speaker.next(), browser.next()]);
    await expect(allSilent).resolves.toBe("no-ack");
  });

  test("the per-client queue still holds across holders: one notice in flight", async () => {
    const { inbox, url } = await startInbox();
    const speaker = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=b");
    const first = inbox.notify("speaker", { id: "one", event: "e" }, { ackTimeoutMs: 5000 });
    const second = inbox.notify("speaker", { id: "two", event: "e" }, { ackTimeoutMs: 5000 });
    expect(await speaker.next()).toMatchObject({ id: "one" });
    expect(await browser.next()).toMatchObject({ id: "one" });
    await Promise.all([roundTrip(speaker), roundTrip(browser)]);
    expect([speaker.frames, browser.frames]).toEqual([[], []]);
    answer(speaker.ws, "ack", "one");
    answer(browser.ws, "ack", "one");
    expect(await speaker.next()).toMatchObject({ id: "two" });
    expect(await browser.next()).toMatchObject({ id: "two" });
    answer(speaker.ws, "ack", "two");
    answer(browser.ws, "ack", "two");
    await expect(Promise.all([first, second])).resolves.toEqual(["acked", "acked"]);
  });

  test("a malformed ?holder= is closed with a reason", async () => {
    const { inbox, url } = await startInbox();
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
    const { inbox, url } = await startInbox();
    const firmware = await connect(url, inbox);
    const browser = await connect(url, inbox, "holder=tab&events=1");
    const committed = event({ type: "userTranscript.committed", text: "what's the weather" });
    inbox.feed("speaker", { type: "session_event", sessionId: "s-1", event: committed });
    expect(await browser.next()).toEqual({
      type: "session_event",
      sessionId: "s-1",
      event: JSON.parse(JSON.stringify(committed)),
    });
    await roundTrip(firmware);
    expect(firmware.frames).toEqual([]);
  });

  test("a session bound to the client reaches it through the published feed, results never", async () => {
    const { inbox, url } = await startInbox();
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
    const { inbox, url } = await startInbox();
    const browser = await connect(url, inbox, "holder=tab&events=1");
    const frame = { type: "session_ended", sessionId: "s-2" } as const;
    // Every socket reads as backed up for one feed — the server's is the one asked.
    {
      using _backedUp = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(INBOX_EVENT_BUFFER_LIMIT_BYTES + 1);
      inbox.feed("speaker", frame);
    }
    inbox.feed("speaker", { ...frame, sessionId: "s-3" });
    expect(await browser.next()).toEqual({ type: "session_ended", sessionId: "s-3" });
    expect(browser.frames).toEqual([]);
  });
});
