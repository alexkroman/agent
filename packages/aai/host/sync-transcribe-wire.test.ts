// Copyright 2026 the AAI authors. MIT license.
/**
 * The Sync API request body has to survive a REAL `fetch` — specifically the
 * pinned one every host-side call goes through.
 *
 * `syncTranscribe` lives in `sdk/` and is handed `RuntimeOptions.fetch`, which
 * on the platform is `safeFetch` → `pinnedFetch`, undici 8 from this package's
 * dependencies. A `globalThis.FormData` body is an instance of the FormData
 * class belonging to the undici bundled into *Node* (`process.versions.undici`,
 * v7), and undici 8's `extractBody` gates its multipart branch on
 * `webidl.is.FormData` — an `instanceof` against its own class. A foreign
 * FormData therefore misses every branch, falls through to the USVString
 * conversion, and goes out as `Content-Type: text/plain` with the 17-byte body
 * `[object FormData]`. AssemblyAI answers 415 ("request must be
 * multipart/form-data with an `audio` part"), surfaced to the browser as
 * `Sync turn failed: HTTP 502`. Same two-undici hazard as
 * `ssrf-dispatcher.test.ts`, one layer up: there the *dispatcher* crossed
 * copies, here the *body*.
 *
 * The whole sdk spec suite injects a fake fetch and asserts on the body
 * object, so it cannot see this — the bytes are only wrong once a real fetch
 * encodes them. This spec therefore posts to a loopback server and reads what
 * actually arrived. It deliberately does not go through `safeFetch`, whose
 * SSRF guard rejects loopback by design; the contract under test is that the
 * encoded body is fetch-implementation-agnostic.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { syncTranscribe } from "../sdk/providers/stt/assemblyai-sync.ts";
import { pinnedFetch } from "./ssrf.ts";

type Received = { contentType: string; body: Buffer };

let server: Server;
let port: number;
let received: Received | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received = {
        contentType: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "hello", words: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the encoded body arrives as multipart through this package's undici", async () => {
  // Recognizable bytes: a value the boundary/headers can't accidentally contain.
  const audio = new Uint8Array(600).fill(0xab);

  const result = await syncTranscribe({
    audio,
    contentType: "audio/pcm",
    sampleRate: 16_000,
    channels: 1,
    apiKey: "test-key",
    // The real `fetch` with the loopback server swapped in for
    // sync.assemblyai.com: the body `init` carries is encoded by the same
    // undici the platform uses, which is the whole point.
    fetch: (_input, init) => pinnedFetch(`http://127.0.0.1:${port}/transcribe`, init),
  });
  expect(result.text).toBe("hello");

  const sent = received;
  if (!sent) throw new Error("server received no request");
  const boundary = /boundary=([^\s;]+)/.exec(sent.contentType)?.[1];
  expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
  if (!boundary) throw new Error(`no boundary in ${sent.contentType}`);

  // Every audio byte survived — the failure mode was a 17-byte body.
  expect(sent.body.length).toBeGreaterThan(audio.length);
  expect(sent.body.includes(Buffer.from(audio))).toBe(true);

  const text = sent.body.toString("latin1");
  expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="audio"`);
  expect(text).toContain('filename="audio.pcm"');
  expect(text).toContain("Content-Type: audio/pcm");
  expect(text).toContain('name="config"');
  expect(text).toContain('{"sample_rate":16000,"channels":1}');
  expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
});
