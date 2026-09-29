// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` against a real socket: what a device sees, and what each way of
 * not taking a notice settles the step's send with.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  answerNotice as answer,
  connectDevice,
  type InboxCleanups,
  startInbox as startOn,
} from "./_client-inbox-test-utils.ts";
import { type ClientInbox, INBOX_FRAME_BYTES } from "./client-inbox.ts";

const cleanups: InboxCleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const startInbox = (pingMs?: number) => startOn(cleanups, pingMs);
const connect = (url: string, inbox: ClientInbox, clientId = "speaker") =>
  connectDevice(cleanups, url, inbox, clientId);

describe("client inbox", () => {
  test("a notice is a header then its bytes in bounded frames, and the ack settles it", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const audio = new Uint8Array(INBOX_FRAME_BYTES * 2 + 10);
    const sent = inbox.notify(
      "speaker",
      { id: "run-1", event: "reminder", data: { text: "call the plumber" }, audio },
      { ackTimeoutMs: 5000 },
    );
    expect(await device.next()).toEqual({
      type: "notice",
      id: "run-1",
      event: "reminder",
      data: { text: "call the plumber" },
      bytes: audio.length,
    });
    expect([await device.next(), await device.next(), await device.next()]).toEqual([
      INBOX_FRAME_BYTES,
      INBOX_FRAME_BYTES,
      10,
    ]);
    answer(device.ws, "ack", "run-1");
    await expect(sent).resolves.toBe("acked");
  });

  test("a notice with no bytes says bytes: 0 and sends no binary frame", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const sent = inbox.notify("speaker", { id: "r", event: "ring" }, { ackTimeoutMs: 5000 });
    expect(await device.next()).toEqual({ type: "notice", id: "r", event: "ring", bytes: 0 });
    answer(device.ws, "ack", "r");
    await expect(sent).resolves.toBe("acked");
    expect(device.frames).toEqual([]);
  });

  test("no socket for the client is offline, at once", async () => {
    const { inbox } = await startInbox();
    await expect(
      inbox.notify("nobody", { id: "r", event: "e" }, { ackTimeoutMs: 5000 }),
    ).resolves.toBe("offline");
  });

  test("busy and a missing ack each settle with their reason", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const busy = inbox.notify("speaker", { id: "b", event: "e" }, { ackTimeoutMs: 5000 });
    await device.next();
    answer(device.ws, "busy", "b");
    await expect(busy).resolves.toBe("busy");
    await expect(
      inbox.notify("speaker", { id: "silent", event: "e" }, { ackTimeoutMs: 50 }),
    ).resolves.toBe("no-ack");
  });

  test("an answer naming another notice does not settle this one", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const sent = inbox.notify("speaker", { id: "mine", event: "e" }, { ackTimeoutMs: 100 });
    await device.next();
    answer(device.ws, "ack", "someone-else");
    await expect(sent).resolves.toBe("no-ack");
  });

  test("a socket that closes mid-send settles it disconnected", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const sent = inbox.notify("speaker", { id: "r", event: "e" }, { ackTimeoutMs: 5000 });
    await device.next();
    device.ws.close();
    await expect(sent).resolves.toBe("disconnected");
    await vi.waitFor(() => expect(inbox.connected()).toEqual([]));
  });

  test("two notices due at once reach the device one after the other", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const first = inbox.notify("speaker", { id: "one", event: "e" }, { ackTimeoutMs: 5000 });
    const second = inbox.notify("speaker", { id: "two", event: "e" }, { ackTimeoutMs: 5000 });
    expect(await device.next()).toMatchObject({ id: "one" });
    // Nothing of the second arrives while the first is unanswered.
    await sleep(50);
    expect(device.frames).toEqual([]);
    answer(device.ws, "ack", "one");
    expect(await device.next()).toMatchObject({ id: "two" });
    answer(device.ws, "ack", "two");
    await expect(Promise.all([first, second])).resolves.toEqual(["acked", "acked"]);
  });

  test("a reconnect under the same id replaces the old socket", async () => {
    const { inbox, url } = await startInbox();
    const old = await connect(url, inbox);
    const closed = new Promise((resolve) => old.ws.once("close", resolve));
    const fresh = await connect(url, inbox);
    await closed;
    const sent = inbox.notify("speaker", { id: "r", event: "e" }, { ackTimeoutMs: 5000 });
    expect(await fresh.next()).toMatchObject({ id: "r" });
    answer(fresh.ws, "ack", "r");
    await expect(sent).resolves.toBe("acked");
    expect(inbox.connected()).toEqual(["speaker"]);
  });

  test("an upgrade naming no valid client is closed with a reason", async () => {
    const { inbox, url } = await startInbox();
    for (const query of ["", "?client=", "?client=a%20b"]) {
      const ws = new WebSocket(`${url}${query}`);
      const [code, reason] = await new Promise<[number, string]>((resolve) =>
        ws.once("close", (c, r) => resolve([c, r.toString()])),
      );
      expect.soft(code, query).toBe(1008);
      expect.soft(reason, query).toContain("?client=");
    }
    expect(inbox.connected()).toEqual([]);
  });

  test("an aborted send rejects with the signal's reason", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const controller = new AbortController();
    const sent = inbox.notify(
      "speaker",
      { id: "r", event: "e" },
      { ackTimeoutMs: 5000, signal: controller.signal },
    );
    await device.next();
    const reason = new Error("step cancelled");
    controller.abort(reason);
    await expect(sent).rejects.toBe(reason);
  });

  test("a device that stops answering pings is dropped", async () => {
    const { inbox, url } = await startInbox(30);
    const device = await connect(url, inbox);
    // `ws` answers pings itself; pausing the socket stops it reading them.
    device.ws.pause();
    await vi.waitFor(() => expect(inbox.connected()).toEqual([]), { timeout: 2000 });
  });

  test("close drops every socket, and a send after it is offline", async () => {
    const { inbox, url } = await startInbox();
    const device = await connect(url, inbox);
    const closed = new Promise((resolve) => device.ws.once("close", resolve));
    inbox.close();
    await closed;
    await expect(
      inbox.notify("speaker", { id: "r", event: "e" }, { ackTimeoutMs: 5000 }),
    ).resolves.toBe("offline");
  });
});
