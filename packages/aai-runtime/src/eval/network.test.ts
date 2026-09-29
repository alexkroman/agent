// Copyright 2026 the AAI authors. MIT license.
/**
 * `evalNetwork` on its own: routing, the refusal it fails closed with, and the
 * log a case asserts over.
 *
 * The property worth the most is the DEFAULT: an unrouted request never leaves.
 * Every hand-rolled fake this replaced forwarded what it did not recognize, and
 * the tests below that pin the refusal are the ones a regression would delete.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { evalNetwork, setEvalPassthroughFetch } from "./network.ts";

afterEach(() => setEvalPassthroughFetch(undefined));

describe("evalNetwork — routes", () => {
  test("a route answers with JSON, and the request is logged with its parsed body", async () => {
    const net = evalNetwork({
      routes: { "api.mem0.ai": (_request, info) => ({ echoed: info.body }) },
    });
    const response = await net.fetch("https://api.mem0.ai/v3/memories/add/", {
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "Biscuit is a beagle" }),
    });
    expect(await response.json()).toEqual({ echoed: { memory: "Biscuit is a beagle" } });
    const [logged] = net.requests();
    expect(logged).toMatchObject({
      method: "POST",
      host: "api.mem0.ai",
      outcome: "routed",
      route: "api.mem0.ai",
      status: 200,
      body: { memory: "Biscuit is a beagle" },
    });
    expect(logged?.headers["content-type"]).toBe("application/json");
  });

  test("the handler gets a readable Request, and a Response it returns is used as is", async () => {
    const net = evalNetwork({
      routes: {
        "crm.example": async (request) =>
          new Response(`got ${await request.text()}`, { status: 201 }),
      },
    });
    const response = await net.fetch("https://crm.example/rows", { method: "POST", body: "a=1" });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("got a=1");
    // A form body stays text in the log.
    expect(net.requests()[0]?.body).toBe("a=1");
  });

  test("undefined answers 204; a throwing handler answers 500 naming the route", async () => {
    const net = evalNetwork({
      routes: {
        "quiet.example": () => undefined,
        "broken.example": () => {
          throw new Error("fixture exploded");
        },
      },
    });
    expect((await net.fetch("https://quiet.example/")).status).toBe(204);
    const broken = await net.fetch("https://broken.example/");
    expect(broken.status).toBe(500);
    expect(await broken.text()).toMatch(/route for broken\.example threw — fixture exploded/);
  });

  test("the most specific key answers: URL prefix, then host, then the longest wildcard", async () => {
    const hit = (name: string) => () => ({ name });
    const net = evalNetwork({
      routes: {
        "*.example": hit("wildcard"),
        "*.crm.example": hit("narrow wildcard"),
        "api.crm.example": hit("host"),
        "https://api.crm.example/rest/v1/calls": hit("prefix"),
      },
    });
    const name = async (url: string) =>
      ((await (await net.fetch(url)).json()) as { name: string }).name;
    expect(await name("https://api.crm.example/rest/v1/calls?id=eq.1")).toBe("prefix");
    expect(await name("https://api.crm.example/rest/v1/profile")).toBe("host");
    expect(await name("https://eu.crm.example/")).toBe("narrow wildcard");
    expect(await name("https://library.springfield.example/")).toBe("wildcard");
  });
});

describe("evalNetwork — failing closed", () => {
  test("an unrouted request is REFUSED by default: it throws, and is logged", async () => {
    const net = evalNetwork({ routes: { "api.mem0.ai": () => ({}) } });
    await expect(net.fetch("https://api.twilio.com/2010-04-01/Calls.json")).rejects.toThrow(
      /refused GET https:\/\/api\.twilio\.com.*Add a route for "api\.twilio\.com"/,
    );
    expect(net.refused().map((r) => r.host)).toEqual(["api.twilio.com"]);
    // Refused is not received: the host's own call list stays empty.
    expect(net.calls("api.twilio.com")).toEqual([]);
  });

  test("a wildcard does not match the bare domain, which is refused", async () => {
    const net = evalNetwork({ routes: { "*.example": () => ({}) } });
    await expect(net.fetch("https://example/")).rejects.toThrow(/refused/);
  });

  test("refuse: '403' answers Forbidden instead, and still logs the refusal", async () => {
    const net = evalNetwork({ refuse: "403" });
    const response = await net.fetch("https://backend.composio.dev/api/v3/tools/execute");
    expect(response.status).toBe(403);
    expect(net.refused()).toHaveLength(1);
    expect(net.refused()[0]?.status).toBe(403);
  });

  test("a passthrough key reaches the fetch the network was told is real, and is logged", async () => {
    const real = vi.fn<typeof fetch>(async () => new Response("real", { status: 200 }));
    setEvalPassthroughFetch(real);
    const net = evalNetwork({ passthrough: ["status.example"] });
    expect(await (await net.fetch("https://status.example/ping")).text()).toBe("real");
    expect(real).toHaveBeenCalledTimes(1);
    expect(net.calls("status.example").map((r) => r.outcome)).toEqual(["passthrough"]);
  });
});

describe("evalNetwork — the log", () => {
  test("requests() filters by key, by URL pattern, or by predicate", async () => {
    const net = evalNetwork({ routes: { "*.example": () => ({}) } });
    await net.fetch("https://a.example/one");
    await net.fetch("https://b.example/two", { method: "DELETE" });
    expect(net.requests()).toHaveLength(2);
    expect(net.requests("a.example").map((r) => r.url.pathname)).toEqual(["/one"]);
    expect(net.requests(/\/two$/).map((r) => r.host)).toEqual(["b.example"]);
    expect(net.requests((r) => r.method === "DELETE").map((r) => r.host)).toEqual(["b.example"]);
    expect(net.calls(/^b\./)).toHaveLength(1);
  });

  test("expectNoOutbound counts a REFUSED request as a try, and lists what matched", async () => {
    const net = evalNetwork();
    net.expectNoOutbound(/twilio/);
    await net.fetch("https://api.twilio.com/Calls").catch(() => undefined);
    expect(() => net.expectNoOutbound(/twilio/)).toThrow(
      /expected no request to \/twilio\/.*GET https:\/\/api\.twilio\.com\/Calls \(refused\)/s,
    );
  });

  test("expectNothingRefused names every refused request", async () => {
    const net = evalNetwork({ routes: { "ok.example": () => ({}) } });
    await net.fetch("https://ok.example/");
    net.expectNothingRefused();
    await net.fetch("https://nope.example/x").catch(() => undefined);
    expect(() => net.expectNothingRefused()).toThrow(
      /1 request\(s\) were refused.*nope\.example\/x/s,
    );
  });

  test("reset() forgets the log", async () => {
    const net = evalNetwork({ routes: { "ok.example": () => ({}) } });
    await net.fetch("https://ok.example/");
    net.reset();
    expect(net.requests()).toEqual([]);
  });
});
