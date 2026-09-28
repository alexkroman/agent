// Copyright 2026 the AAI authors. MIT license.
// The two connect-URL builders. Both routes a session can dial — the
// same-origin `websocket` path and a broker's `sessionUrl` — must carry the
// same parameters, or a client's `location` would be heard on `aai dev` and
// silently lost on the platform (or the reverse).

import { describe, expect, test } from "vitest";
import { buildBrokeredWsUrl, buildWsUrl } from "./session-core-url.ts";

const params = (url: URL) => Object.fromEntries(url.searchParams);

describe.each([
  [
    "same-origin",
    (resume: boolean, sid?: string, loc?: string) =>
      buildWsUrl("https://host/agent/", resume, sid, { location: loc }),
  ],
  [
    "brokered",
    (resume: boolean, sid?: string, loc?: string) =>
      buildBrokeredWsUrl("https://sandbox.example/websocket", resume, sid, { location: loc }),
  ],
])("%s connect URL", (_route, build) => {
  test("switches to the WebSocket scheme", () => {
    expect(build(false).protocol).toBe("wss:");
  });

  test("a first connect carries no resume parameter", () => {
    expect(params(build(false))).toEqual({});
  });

  test("a resume carries the session id, and only falls back to resume=1 without one", () => {
    expect(params(build(true, "s-1"))).toEqual({ sessionId: "s-1" });
    expect(params(build(true))).toEqual({ resume: "1" });
  });

  test("`location` rides on every attempt — first, resumed or fallback", () => {
    const loc = "Portland, Oregon";
    expect(params(build(false, undefined, loc))).toEqual({ location: loc });
    expect(params(build(true, "s-1", loc))).toEqual({ sessionId: "s-1", location: loc });
    expect(params(build(true, undefined, loc))).toEqual({ resume: "1", location: loc });
  });

  test("an empty location sends no parameter", () => {
    expect(params(build(false, undefined, ""))).toEqual({});
  });

  test("a location is URL-encoded, not spliced", () => {
    const url = build(false, undefined, "1 Main St & 2nd Ave #4");
    expect(url.searchParams.get("location")).toBe("1 Main St & 2nd Ave #4");
    expect(url.search).not.toContain("&2nd");
  });
});

test("a broker URL that already names a location is overridden, never doubled", () => {
  const url = buildBrokeredWsUrl(
    "https://sandbox.example/websocket?location=old",
    false,
    undefined,
    { location: "new" },
  );
  expect(url.searchParams.getAll("location")).toEqual(["new"]);
});

describe.each([
  ["same-origin", (phone?: string) => buildWsUrl("https://host/agent/", true, "s-1", { phone })],
  [
    "brokered",
    (phone?: string) =>
      buildBrokeredWsUrl("https://sandbox.example/websocket", true, "s-1", { phone }),
  ],
])("%s connect URL `phone`", (_route, build) => {
  test("rides beside the resume id, URL-encoded", () => {
    const url = build("+15035550123");
    expect(params(url)).toEqual({ sessionId: "s-1", phone: "+15035550123" });
    expect(url.search).toContain("phone=%2B15035550123");
  });

  test("an empty or absent one sends no parameter", () => {
    expect(params(build(""))).toEqual({ sessionId: "s-1" });
    expect(params(build())).toEqual({ sessionId: "s-1" });
  });
});

test("a broker URL that already names a phone is overridden, never doubled", () => {
  const url = buildBrokeredWsUrl("https://sandbox.example/websocket?phone=old", false, undefined, {
    phone: "+15035550123",
  });
  expect(url.searchParams.getAll("phone")).toEqual(["+15035550123"]);
});

describe.each([
  ["same-origin", (client?: string) => buildWsUrl("https://host/agent/", true, "s-1", { client })],
  [
    "brokered",
    (client?: string) =>
      buildBrokeredWsUrl("https://sandbox.example/websocket", true, "s-1", { client }),
  ],
])("%s connect URL `client`", (_route, build) => {
  test("rides beside the resume id", () => {
    expect(params(build("kitchen-speaker"))).toEqual({
      sessionId: "s-1",
      client: "kitchen-speaker",
    });
  });

  test("an empty or absent one sends no parameter", () => {
    expect(params(build(""))).toEqual({ sessionId: "s-1" });
    expect(params(build())).toEqual({ sessionId: "s-1" });
  });
});

test("a broker URL that already names a client is overridden, never doubled", () => {
  const url = buildBrokeredWsUrl("https://sandbox.example/websocket?client=old", false, undefined, {
    client: "kitchen-speaker",
  });
  expect(url.searchParams.getAll("client")).toEqual(["kitchen-speaker"]);
});
