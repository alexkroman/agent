// Copyright 2026 the AAI authors. MIT license.
// The mock platform API the CLI's integration specs run against
// (_mock-api.ts): its auth gate, routes, overrides and recording. Scenario
// tier because it listens on a real port.

import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type MockApi, startMockApi } from "./_mock-api.ts";

let api: MockApi;

beforeAll(async () => {
  api = await startMockApi();
});

afterEach(() => {
  api.clear();
});

afterAll(async () => {
  await api.stop();
});

const AUTH = { Authorization: "Bearer test-key" };

function send(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${api.url}${path}`, { ...init, headers: { ...AUTH, ...init.headers } });
}

describe("startMockApi", () => {
  test("listens on loopback and records every request, refused ones too", async () => {
    expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${api.url}/deploy`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(api.requests).toEqual([
      expect.objectContaining({ method: "POST", path: "/deploy", body: "{}" }),
    ]);
  });

  test("refuses the designated invalid key by name", async () => {
    const res = await fetch(`${api.url}/my-agent/secret`, {
      headers: { Authorization: "Bearer invalid-key" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
  });

  test("deploy echoes the slug sent, else mints one, and inflates a gzipped body", async () => {
    const named = await send("/deploy", {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: gzipSync(JSON.stringify({ slug: "my-agent" })),
    });
    expect(await named.json()).toEqual({ ok: true, slug: "my-agent" });
    // Recorded decoded, so a spec asserts on JSON rather than gzip bytes.
    expect(JSON.parse(api.requests[0]?.body ?? "")).toEqual({ slug: "my-agent" });

    const minted = await send("/deploy", { method: "POST", body: "{}" });
    expect(await minted.json()).toEqual({ ok: true, slug: expect.stringMatching(/^generated-/) });
  });

  test("secrets round-trip through put, list and delete", async () => {
    await send("/my-agent/secret", { method: "PUT", body: JSON.stringify({ A: "1", B: "2" }) });
    expect(api.secrets).toEqual({ A: "1", B: "2" });
    expect(await (await send("/my-agent/secret")).json()).toEqual({ vars: ["A", "B"] });

    await send("/my-agent/secret/A", { method: "DELETE" });
    expect(api.secrets).toEqual({ B: "2" });
  });

  test("an unknown route is 404 and a malformed body is 500", async () => {
    expect((await send("/nowhere/at/all")).status).toBe(404);
    expect((await send("/my-agent/secret", { method: "PUT", body: "{not json" })).status).toBe(500);
  });

  test("an override answers by method and path prefix, until cleared", async () => {
    api.override("DELETE", "/my-agent", 404, '{"error":"gone"}');
    const overridden = await send("/my-agent", { method: "DELETE" });
    expect(overridden.status).toBe(404);
    expect(await overridden.text()).toBe('{"error":"gone"}');

    api.clear();
    expect(api.requests).toEqual([]);
    expect((await send("/my-agent", { method: "DELETE" })).status).toBe(200);
  });
});
