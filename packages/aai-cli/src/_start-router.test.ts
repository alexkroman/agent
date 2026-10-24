// Copyright 2026 the AAI authors. MIT license.
/**
 * The router's pure halves: which slot a request picks, and the request head
 * it replays into a handed-off socket. The proxy and the handoff themselves
 * bind real ports, so they are in `_start-router.scenario.test.ts`.
 */

import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { clientKey, slotOf } from "./_start-affinity.ts";
import { createSlotPicker, serializeRequestHead } from "./_start-router.ts";
import type { ReadyWorker, WorkerLike } from "./_start-workers.ts";

const worker: WorkerLike = { pid: 1, kill: () => undefined, send: () => true };

function pickerWith(slots: number, up: number[]) {
  const live = new Set(up);
  return createSlotPicker({
    slots,
    target: (slot): ReadyWorker | undefined => (live.has(slot) ? { worker, port: 1 } : undefined),
  });
}

describe("createSlotPicker", () => {
  test("a keyed request always picks its key's slot", () => {
    const pick = pickerWith(4, [0, 1, 2, 3]);
    const key = clientKey("phone-1");
    expect(pick(key)).toEqual({ slot: slotOf(key, 4), worker: { worker, port: 1 } });
    expect(pick(key)?.slot).toBe(slotOf(key, 4));
  });

  test("a keyed request whose slot is restarting picks nothing — never another worker", () => {
    const key = clientKey("phone-1");
    const down = slotOf(key, 4);
    const pick = pickerWith(
      4,
      [0, 1, 2, 3].filter((slot) => slot !== down),
    );
    expect(pick(key)).toBeUndefined();
  });

  test("unkeyed requests rotate over the listening slots, skipping one that is down", () => {
    const pick = pickerWith(3, [0, 2]);
    const slots = [pick(undefined), pick(undefined), pick(undefined), pick(undefined)].map(
      (picked) => picked?.slot,
    );
    expect(slots).toEqual([0, 2, 0, 2]);
  });

  test("with no slot listening, an unkeyed request picks nothing", () => {
    expect(pickerWith(2, [])(undefined)).toBeUndefined();
  });
});

describe("serializeRequestHead", () => {
  test("re-serializes the request line and raw headers, preserving case and order", () => {
    // A real message over an unconnected socket: no network.
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/websocket?client=abc";
    req.httpVersion = "1.1";
    req.rawHeaders = ["Host", "x", "Upgrade", "websocket", "Sec-WebSocket-Key", "k=="];
    expect(serializeRequestHead(req).toString("latin1")).toBe(
      "GET /websocket?client=abc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k==\r\n\r\n",
    );
  });
});
