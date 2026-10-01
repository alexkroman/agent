// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// `resume(sessionId)`: continue an EARLIER session from the page, without a
// reload — the next attempt presents that id, the id is stored like a `config`
// frame's, and a malformed one is refused before the current call is touched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "../_session-core-test-utils.ts";
import { createBrowserSession } from "./browser-session.ts";
import { createDialer } from "./dial.ts";
import { readStoredSessionId } from "./resume-store.ts";
import type { BrowserSession } from "./types.ts";

const AGENT = "ws://localhost:3000";
const params = (url: string | undefined) => Object.fromEntries(new URL(url ?? "").searchParams);

describe("BrowserSession.resume", () => {
  let core: BrowserSession;

  beforeEach(() => {
    sessionStorage.clear();
    resetLastSocket();
    core = createBrowserSession({
      platformUrl: AGENT,
      WebSocket: MockWebSocketConstructor,
      client: "kitchen",
    });
  });

  afterEach(() => {
    core.disconnect();
    sessionStorage.clear();
  });

  it("hangs up the live call and dials the picked session, with the client beside it", () => {
    core.start();
    const live = lastSocket;
    live?.simulateOpen();
    live?.simulateMessage(makeConfig(16_000, 24_000, "current-session"));

    core.resume("older-session");

    expect(live?.close).toHaveBeenCalled();
    expect(lastSocket).not.toBe(live);
    expect(params(lastSocket?.url)).toEqual({ sessionId: "older-session", client: "kitchen" });
    const snap = core.getSnapshot();
    expect(snap).toMatchObject({ started: true, running: true, messages: [] });
  });

  it("is stored like a config frame's id, so a reload continues it too", () => {
    core.resume("older-session");
    expect(readStoredSessionId(AGENT)).toBe("older-session");
  });

  it("works from a session that never started", () => {
    core.resume("older-session");
    expect(params(lastSocket?.url)).toMatchObject({ sessionId: "older-session" });
  });

  it("a malformed id throws BEFORE the current call is touched", () => {
    core.start();
    const live = lastSocket;
    live?.simulateOpen();
    for (const bad of ["", "a b", "x".repeat(129), "../etc"]) {
      expect.soft(() => core.resume(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
    expect(lastSocket).toBe(live);
    expect(live?.close).not.toHaveBeenCalled();
    expect(core.getSnapshot().running).toBe(true);
  });

  it("the server's config after the resume keeps the resumed id current", () => {
    core.resume("older-session");
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig(16_000, 24_000, "older-session"));
    lastSocket?.simulateClose();
    core.toggle();
    expect(params(lastSocket?.url)).toMatchObject({ sessionId: "older-session" });
  });
});

describe("createDialer adopt", () => {
  it("makes the next attempt present the adopted id, replacing the one it had", () => {
    sessionStorage.clear();
    const dialer = createDialer({ platformUrl: AGENT, WebSocket: MockWebSocketConstructor });
    dialer.configured("first");
    dialer.adopt("second");
    expect(params(dialer.open().url)).toEqual({ sessionId: "second" });
    expect(readStoredSessionId(AGENT)).toBe("second");
  });
});
