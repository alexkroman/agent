// Copyright 2026 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stepFetch } from "./step-fetch.ts";
import { type StubFetchRoutes, stubFetchRoutes } from "./testing-fetch-routes.ts";
import { installFetchRoutes } from "./testing-vitest.ts";

/** A stand-in for "the real network", so a passthrough is observable offline. */
const realCalls: string[] = [];
const realFetch = (async (input: string | URL | Request) => {
  realCalls.push(input instanceof Request ? input.url : String(input));
  return new Response("real", { status: 200 });
}) as typeof globalThis.fetch;

let saved: typeof globalThis.fetch;
let net: StubFetchRoutes | undefined;
beforeEach(() => {
  saved = globalThis.fetch;
  globalThis.fetch = realFetch;
  realCalls.length = 0;
});
afterEach(() => {
  net?.restore();
  net = undefined;
  globalThis.fetch = saved;
});

describe("stubFetchRoutes", () => {
  test("routes by host, wildcard and URL prefix, the most specific key winning", async () => {
    net = stubFetchRoutes({
      "api.mem0.ai": { body: { from: "host" } },
      "https://api.mem0.ai/v3/memories/": { body: { from: "prefix" } },
      "*.example": { body: { from: "wildcard" } },
    });
    const read = async (url: string) =>
      ((await (await fetch(url)).json()) as { from: string }).from;
    expect(await read("https://api.mem0.ai/v3/memories/add/")).toBe("prefix");
    expect(await read("https://api.mem0.ai/v1/other")).toBe("host");
    expect(await read("https://market.springfield.example/")).toBe("wildcard");
    expect(net.hits.map((h) => h.route)).toEqual([
      "https://api.mem0.ai/v3/memories/",
      "api.mem0.ai",
      "*.example",
    ]);
  });

  test("a METHOD-qualified key answers only that method, and beats the bare key", async () => {
    net = stubFetchRoutes({
      "supabase.test": { body: [] },
      "POST supabase.test": { status: 201 },
      "DELETE supabase.test": { status: 204 },
    });
    expect((await fetch("https://supabase.test/rest/v1/calls", { method: "POST" })).status).toBe(
      201,
    );
    expect((await fetch("https://supabase.test/rest/v1/calls", { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await fetch("https://supabase.test/rest/v1/calls")).status).toBe(200);
    expect(net.to("POST supabase.test")).toHaveLength(1);
    expect(net.to("supabase.test")).toHaveLength(3);
  });

  test("hands a route the parsed URL and JSON body, and records them", async () => {
    net = stubFetchRoutes({
      "supabase.test": (req) => ({
        body: { id: req.searchParams.get("id"), path: req.pathname, got: req.json },
      }),
    });
    const res = await fetch("https://supabase.test/rest/v1/calls?id=eq.7", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(await res.json()).toEqual({
      id: "eq.7",
      path: "/rest/v1/calls",
      got: { status: "approved" },
    });
    expect(net.hits[0]).toMatchObject({
      method: "PATCH",
      host: "supabase.test",
      json: { status: "approved" },
      outcome: "routed",
      via: "fetch",
    });
  });

  test("a route answering undefined declines, and a list tries each in order", async () => {
    net = stubFetchRoutes([
      (req) => (req.host === "a.test" ? { body: "a" } : undefined),
      () => ({ body: "fallback" }),
    ]);
    expect(await (await fetch("https://a.test/")).text()).toBe("a");
    expect(await (await fetch("https://b.test/")).text()).toBe("fallback");
  });

  test("an unmatched request throws naming it, and is logged", async () => {
    net = stubFetchRoutes({ "a.test": { body: {} } });
    await expect(fetch("https://api.twilio.com/Calls", { method: "POST" })).rejects.toThrow(
      "no fetch route for POST https://api.twilio.com/Calls",
    );
    expect(net.to(/twilio/)).toMatchObject([{ outcome: "unmatched" }]);
    expect(realCalls).toEqual([]);
  });

  test("`notFound` answers 404, and `passthrough` reaches the real fetch", async () => {
    net = stubFetchRoutes({}, { unmatched: "notFound" });
    expect((await fetch("https://x.test/")).status).toBe(404);
    net.restore();
    net = stubFetchRoutes({}, { unmatched: "passthrough" });
    expect(await (await fetch("https://x.test/")).text()).toBe("real");
    expect(net.hits[0]?.outcome).toBe("passthrough");
  });

  test("`passThrough` sends matching URLs to the real network before any route", async () => {
    net = stubFetchRoutes(
      { "*.assemblyai.com": { body: "routed" } },
      { passThrough: /assemblyai\.com/ },
    );
    expect(await (await fetch("https://llm.assemblyai.com/v1")).text()).toBe("real");
    expect(realCalls).toEqual(["https://llm.assemblyai.com/v1"]);
  });

  test("a step's stepFetch lands in the same routes and the same log", async () => {
    net = stubFetchRoutes({ "POST textbelt.com": { body: { success: true } } });
    const res = await stepFetch("https://textbelt.com/text", {
      method: "POST",
      body: JSON.stringify({ phone: "+15555550100" }),
    });
    expect(await res.json()).toEqual({ success: true });
    expect(net.hits).toMatchObject([
      { via: "stepFetch", json: { phone: "+15555550100" }, outcome: "routed" },
    ]);
  });

  test("restore puts the global back and unpublishes the step fetch", async () => {
    net = stubFetchRoutes({ "a.test": { body: {} } });
    net.restore();
    expect(globalThis.fetch).toBe(realFetch);
    // Unpublished, stepFetch falls back to the global — the stand-in.
    expect(await (await stepFetch("https://a.test/")).text()).toBe("real");
  });

  test("a fixed Response is answered afresh each time", async () => {
    net = stubFetchRoutes({ "a.test": new Response("once") });
    expect(await (await fetch("https://a.test/")).text()).toBe("once");
    expect(await (await fetch("https://a.test/")).text()).toBe("once");
  });
});

describe("installFetchRoutes", () => {
  test("installs for this test", async () => {
    const routed = installFetchRoutes({ "a.test": { body: { ok: true } } });
    expect(await (await fetch("https://a.test/")).json()).toEqual({ ok: true });
    expect(routed.hits).toHaveLength(1);
  });

  test("and is gone by the next", async () => {
    expect(await (await fetch("https://a.test/")).text()).toBe("real");
  });
});
