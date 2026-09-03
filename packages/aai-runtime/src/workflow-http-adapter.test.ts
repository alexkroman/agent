// Copyright 2026 the AAI authors. MIT license.
/**
 * The adapter's BODY BOUND, which is the whole security property of this module.
 *
 * `serveFetch` sits in front of the one unauthenticated public route in the
 * product (`/.well-known/workflow/v1/webhook/:token`), so whatever it does with
 * a body it does for an attacker-chosen number of bytes. It used to read the
 * whole stream into an array, concatenate it, hand it to `new Request` and let
 * the HANDLER discover the request was too large — three copies resident before
 * any 413 was produced.
 *
 * The discriminating assertion is therefore NOT the status code: the old code
 * answered 413 too. It is that the handler is never reached and that no buffer
 * bigger than the cap is ever materialised, measured by counting what
 * `Buffer.concat` is asked to join. Against the unbounded version that number
 * is the whole body.
 *
 * The doubles are REAL `IncomingMessage`/`ServerResponse` objects over a
 * never-connected socket rather than casts, so the reader under test meets the
 * stream semantics it meets in production and this file spends none of the
 * escape-hatch budget.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { serveFetch } from "./workflow-http-adapter.ts";

const CAP = 1024 * 1024;

/** A request whose body arrives in chunks AFTER a reader is attached. */
function makeRequest(chunks: Buffer[]): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.url = "/.well-known/workflow/v1/webhook/tok";
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  // Deferred: the property under test is what happens WHILE the body arrives,
  // which a body already buffered on the stream cannot exercise.
  setImmediate(() => {
    for (const chunk of chunks) req.push(chunk);
    req.push(null);
  });
  return req;
}

/** The largest single buffer any of these `Buffer.concat` calls was asked to build. */
function largestConcat(calls: readonly (readonly [readonly Uint8Array[], ...unknown[]])[]): number {
  let largest = 0;
  for (const [list] of calls) {
    let total = 0;
    for (const part of list) total += part.length;
    largest = Math.max(largest, total);
  }
  return largest;
}

const opts = { logger: silentLogger, label: "Workflow webhook", failureStatus: 502 };

describe("serveFetch bounds the body as it is read", () => {
  test("an oversized body is refused, and the handler never sees it", async () => {
    const handler = vi.fn(async () => new Response("{}", { status: 200 }));
    const concat = vi.spyOn(Buffer, "concat");
    const req = makeRequest([
      Buffer.alloc(CAP, 0x61),
      Buffer.alloc(CAP, 0x61),
      Buffer.alloc(CAP, 0x61),
    ]);
    const res = new ServerResponse(req);
    const writeHead = vi.spyOn(res, "writeHead");

    await serveFetch(handler, req, res, { ...opts, maxBodyBytes: CAP });

    expect(writeHead.mock.calls[0]?.[0]).toBe(413);
    // The finding: the request never became a `Request`, so the bytes were
    // never copied into one.
    expect(handler).not.toHaveBeenCalled();
    // And nothing over the cap was ever joined into one buffer. Against the
    // unbounded reader this is the full 3 MB.
    expect(largestConcat(concat.mock.calls)).toBeLessThanOrEqual(CAP);
  });

  test("a body under the cap still reaches the handler intact", async () => {
    // Read INSIDE the handler: a `Request`'s body is a one-shot stream, so a
    // spec that reads it afterwards is reading a body the handler consumed.
    const seen = vi.fn();
    const handler = async (request: Request) => {
      seen(await request.text());
      return new Response("{}", { status: 200 });
    };
    const req = makeRequest([Buffer.from('{"ok":'), Buffer.from("true}")]);
    const res = new ServerResponse(req);
    const writeHead = vi.spyOn(res, "writeHead");

    await serveFetch(handler, req, res, { ...opts, maxBodyBytes: CAP });

    expect(writeHead.mock.calls[0]?.[0]).toBe(200);
    expect(seen).toHaveBeenCalledWith('{"ok":true}');
  });

  test("a bodiless request is served with no body at all", async () => {
    // A `Request` with a body and no `duplex` throws, so the empty case is its
    // own path rather than a zero-length body.
    const handler = vi.fn(async (request: Request) => new Response(request.method));
    const req = makeRequest([]);
    req.method = "GET";
    const res = new ServerResponse(req);
    const writeHead = vi.spyOn(res, "writeHead");

    await serveFetch(handler, req, res, { ...opts, maxBodyBytes: CAP });

    expect(writeHead.mock.calls[0]?.[0]).toBe(200);
    expect(handler.mock.calls[0]?.[0]?.body).toBe(null);
  });
});
