// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `routeFetch` against a stubbed `fetch`: the URL (resolved against the
 * page's directory, with `?client=`), the JSON body, the route's own
 * `{ error }` sentence on failure, and a non-JSON failure.
 */

import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { routeFetch } from "./route-fetch.ts";

let fetchMock: Mock<(url: URL, init: RequestInit) => Promise<Response>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    origin: "https://h",
    pathname: "/kitchen/",
    href: "https://h/kitchen/",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lastUrl = () => String(fetchMock.mock.calls.at(-1)?.[0]);

describe("routeFetch", () => {
  test("resolves under the page's directory, adds ?client=, and sends the body as JSON", async () => {
    await expect(
      routeFetch("PUT", "/profile?x=1", { name: "Sam" }, { client: "browser-1" }),
    ).resolves.toEqual({ ok: true });
    expect(lastUrl()).toBe("https://h/kitchen/api/profile?x=1&client=browser-1");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"name":"Sam"}',
    });
  });

  test("with no body and no client, sends neither", async () => {
    await routeFetch("GET", "/memories");
    expect(lastUrl()).toBe("https://h/kitchen/api/memories");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ method: "GET" });
  });

  test("a failure throws the route's own sentence, else method, path and status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "No such memory" }, 404));
    await expect(routeFetch("DELETE", "/memories/9")).rejects.toThrow("No such memory");
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(routeFetch("GET", "/tasks")).rejects.toThrow("GET /tasks: 502");
  });

  test("a 2xx with no JSON body resolves {}", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(routeFetch("POST", "/ping")).resolves.toEqual({});
  });
});
