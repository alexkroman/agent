// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  parseJsonText,
  parseRouteKey,
  recordFetchRequest,
  routeKeyMatches,
  routeTable,
} from "./_route-keys.ts";

const url = (href: string) => new URL(href);

describe("parseRouteKey", () => {
  test("splits an optional upper-case method off the key", () => {
    expect(parseRouteKey("POST textbelt.com")).toEqual({
      key: "POST textbelt.com",
      method: "POST",
      where: "textbelt.com",
    });
    expect(parseRouteKey(" api.mem0.ai ")).toEqual({
      key: " api.mem0.ai ",
      method: undefined,
      where: "api.mem0.ai",
    });
    // A URL prefix is lower-case scheme first, so it is never read as a method.
    expect(parseRouteKey("https://x.example/a").method).toBeUndefined();
  });
});

describe("routeKeyMatches", () => {
  test("host, wildcard (not the bare domain) and URL prefix", () => {
    expect(routeKeyMatches("api.example", "GET", url("https://api.example/x"))).toBe(true);
    expect(routeKeyMatches("api.example", "GET", url("https://eu.api.example/"))).toBe(false);
    expect(routeKeyMatches("*.example", "GET", url("https://a.b.example/"))).toBe(true);
    expect(routeKeyMatches("*.example", "GET", url("https://example/"))).toBe(false);
    expect(routeKeyMatches("https://a.example/v1/", "GET", url("https://a.example/v1/x"))).toBe(
      true,
    );
    expect(routeKeyMatches("https://a.example/v1/", "GET", url("https://a.example/v2"))).toBe(
      false,
    );
  });

  test("a method-qualified key matches only that method, case-insensitively on the request", () => {
    expect(routeKeyMatches("POST a.example", "post", url("https://a.example/"))).toBe(true);
    expect(routeKeyMatches("POST a.example", "GET", url("https://a.example/"))).toBe(false);
  });
});

describe("routeTable", () => {
  test("orders matches: URL prefix, host, longest wildcard; a method beats none", () => {
    const table = routeTable({
      "*.example": "wildcard",
      "*.crm.example": "narrow wildcard",
      "api.crm.example": "host",
      "POST api.crm.example": "post host",
      "https://api.crm.example/rest/": "prefix",
    });
    const names = (method: string, href: string) =>
      table.match(method, url(href)).map((m) => m.value);
    expect(names("GET", "https://api.crm.example/rest/x")).toEqual([
      "prefix",
      "host",
      "narrow wildcard",
      "wildcard",
    ]);
    expect(table.best("POST", url("https://api.crm.example/x"))?.key).toBe("POST api.crm.example");
    expect(table.best("GET", url("https://nowhere.test/"))).toBeUndefined();
  });

  test("equally specific keys keep declaration order", () => {
    const table = routeTable({ "a.example": 1, " a.example": 2 });
    expect(table.best("GET", url("https://a.example/"))?.value).toBe(1);
  });
});

describe("recordFetchRequest / parseJsonText", () => {
  test("records without consuming the body", async () => {
    const request = new Request("https://a.example/x", {
      method: "post",
      headers: { "X-Thing": "1" },
      body: '{"a":1}',
    });
    const recorded = await recordFetchRequest(request);
    expect(recorded).toEqual({
      url: "https://a.example/x",
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", "x-thing": "1" },
      text: '{"a":1}',
    });
    expect(await request.text()).toBe('{"a":1}');
    expect((await recordFetchRequest(new Request("https://a.example/"))).text).toBeUndefined();
  });

  test("boxes JSON so null is told apart from not-JSON", () => {
    expect(parseJsonText("null")).toEqual({ json: null });
    expect(parseJsonText("a=1")).toBeUndefined();
    expect(parseJsonText("")).toBeUndefined();
    expect(parseJsonText(undefined)).toBeUndefined();
  });
});
