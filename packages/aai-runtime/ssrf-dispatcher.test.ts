// Copyright 2026 the AAI authors. MIT license.
/**
 * The pinning dispatcher and the `fetch` it is handed to must come from the
 * SAME undici. Node's global `fetch` is backed by the undici bundled into the
 * runtime (`process.versions.undici`), while `Agent` here comes from the
 * `undici` package in this package's dependencies — and undici 8 changed the
 * dispatch-handler interface, so a v7-style handler built by Node's internal
 * fetch is rejected by a v8 `Agent` with `invalid onRequestStart method`,
 * surfacing as a bare `TypeError: fetch failed`.
 *
 * Every host-side network builtin (`web_search`,
 * `visit_webpage`, `get_page_design`, `fetch_json`) and the platform's
 * guest-fetch proxy route through `safeFetch`, which pins DNS on every
 * hostname — so that mismatch takes out all host egress at once. The rest of
 * the SSRF suite injects a fake fetch and never constructs a real dispatcher,
 * which is exactly why it went unnoticed.
 *
 * This spec pairs the two against a loopback server. It deliberately does not
 * go through `safeFetch` (whose SSRF guard rejects loopback by design) — the
 * contract under test is only that the dispatcher and the fetch agree.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedFetch } from "@alexkroman1/aai/host-internal";
import { Agent } from "undici";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("pinnedFetch accepts a dispatcher built from this package's undici", async () => {
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    },
  });
  // Same nominal mismatch `pinnedDispatcher` bridges: `@types/node` types
  // `RequestInit.dispatcher` from its own bundled `undici-types`, a different
  // copy of the declarations than the `undici` package `Agent` comes from.
  const init: RequestInit = {
    dispatcher: agent as unknown as NonNullable<RequestInit["dispatcher"]>,
  };
  const response = await pinnedFetch(`http://127.0.0.1:${port}/`, init);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("ok");
});
