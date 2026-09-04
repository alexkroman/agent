// Copyright 2026 the AAI authors. MIT license.
/**
 * The two HTTP primitives both `/studio/*` surfaces share.
 *
 * `readBody`'s interesting case is the one its own header names: a client that
 * goes away mid-upload emits `close` and — not reliably — `error`, so without
 * the `close` guard the promise never settles and the accumulated chunks are
 * retained for the life of the guest. A leak like that has no symptom to
 * assert on later, which is why the assertion here is simply that the promise
 * SETTLES.
 *
 * UNIT tier: real `IncomingMessage`/`ServerResponse` objects over an
 * unconnected socket — no listener, no port, no filesystem. The stream is fed
 * by `push`, which is the typed seam that keeps a fake request out of this
 * file (and any cast with it).
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { CORS_HEADERS, readBody, sendJson } from "./studio-http.ts";

/**
 * A real request whose bytes this test pushes in, plus the response wired to
 * it.
 *
 * `assignSocket` is what makes a detached `ServerResponse` writable at all,
 * and intercepting the socket's `write` is what lets the assertions read the
 * bytes without a peer to send them to — the same shape `studio-chat.test.ts`
 * uses for the surface one layer up.
 */
function exchange(): {
  req: IncomingMessage;
  res: ServerResponse;
  written: () => string;
} {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const socket = new Socket();
  socket.write = (chunk: Uint8Array | string): boolean => {
    // Narrowed rather than cast: `Buffer.from` has no overload for the union,
    // and a cast here would be a laundered value in place of two branches.
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    return true;
  };
  res.assignSocket(socket);
  return { req, res, written: () => Buffer.concat(chunks).toString("utf8") };
}

describe("readBody", () => {
  test("concatenates the request's chunks as utf-8", async () => {
    const { req } = exchange();
    const body = readBody(req, 1024);
    req.push(Buffer.from('{"a":"é'));
    req.push(Buffer.from('ü"}'));
    req.push(null);
    await expect(body).resolves.toBe('{"a":"éü"}');
  });

  test("rejects past the cap and destroys the request", async () => {
    const { req } = exchange();
    const body = readBody(req, 8);
    req.push(Buffer.alloc(9, 0x61));
    await expect(body).rejects.toThrow("Request body too large");
    // Destroying is the half that matters at runtime: the sender is still
    // pushing, and rejecting alone would leave it doing so.
    expect(req.destroyed).toBe(true);
  });

  test("counts across chunks, so a cap cannot be split past", async () => {
    const { req } = exchange();
    const body = readBody(req, 4);
    req.push(Buffer.from("abc"));
    req.push(Buffer.from("de"));
    await expect(body).rejects.toThrow("Request body too large");
  });

  test("a body exactly at the cap is admitted", async () => {
    const { req } = exchange();
    const body = readBody(req, 4);
    req.push(Buffer.from("abcd"));
    req.push(null);
    await expect(body).resolves.toBe("abcd");
  });

  test("a close without end SETTLES rather than parking forever", async () => {
    const { req } = exchange();
    const body = readBody(req, 1024);
    req.push(Buffer.from("half a payl"));
    // The aborted upload: no `end`, and Node does not reliably emit `error`.
    req.destroy();
    await expect(body).rejects.toThrow("Request closed before body completed");
  });

  test("a stream error rejects with the stream's own error", async () => {
    const { req } = exchange();
    const body = readBody(req, 1024);
    req.destroy(new Error("ECONNRESET"));
    await expect(body).rejects.toThrow("ECONNRESET");
  });

  test("the close guard does not spoil a completed read", async () => {
    const { req } = exchange();
    const body = readBody(req, 1024);
    const closed = new Promise<void>((resolve) => req.on("close", () => resolve()));
    req.push(Buffer.from("done"));
    req.push(null);
    // `close` follows `end` on every completed request, so the guard fires on
    // the happy path too — settling twice is harmless because the first
    // settle wins, and this is what says so. Wait for the event rather than
    // for a tick budget: the rejection would otherwise land after the assert.
    await closed;
    await expect(body).resolves.toBe("done");
  });
});

describe("sendJson", () => {
  test("writes the status, the JSON body and this surface's CORS policy", () => {
    const { res, written } = exchange();
    sendJson(res, 423, { error: "a turn is already running" });
    const out = written();
    expect(out).toContain("HTTP/1.1 423");
    expect(out).toContain("Content-Type: application/json");
    expect(out.endsWith('{"error":"a turn is already running"}')).toBe(true);
    // The browser talks to `/studio/chat` from the studio origin, so every
    // answer — errors included — has to carry these three.
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      expect(out).toContain(`${name}: ${value}`);
    }
  });

  test("the CORS policy is the narrow one both surfaces expect", () => {
    // POST plus the preflight, and exactly the two headers the chat surface
    // sends (a bearer and a JSON content type). Widening this is a decision,
    // not a detail.
    expect(CORS_HEADERS).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
    });
  });
});
