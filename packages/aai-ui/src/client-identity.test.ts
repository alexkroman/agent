// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * The ids `client: "auto"` mints and `session.identity` reports.
 *
 * The rule this file exists to hold is the per-TAB holder: two tabs of one
 * browser share `localStorage`, so they must share the CLIENT id (one
 * conversation, one reminder address) and must NOT share the holder id — an app
 * that used the browser-wide id as the holder had the tabs replace each other's
 * inbox socket about once a second, forever. A "tab" here is a fresh module
 * realm over the same storage (`vi.resetModules()`), which is exactly what a
 * second page load is.
 */

import { CLIENT_ID_RE } from "@alexkroman1/aai/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { browserClientId, createSessionIdentity, inboxHolderId } from "./client-identity.ts";
import { createBrowserSession } from "./session/index.ts";

const AGENT = "http://localhost:3000/";

/** A second page load: the same storage, a new module realm. */
async function openTab(): Promise<typeof import("./client-identity.ts")> {
  vi.resetModules();
  return await import("./client-identity.ts");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLastSocket();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browserClientId", () => {
  test("mints an unguessable, valid id and keeps it in localStorage", async () => {
    const tab = await openTab();
    const id = tab.browserClientId(AGENT);
    expect(id).toMatch(/^browser-[0-9a-f]{32}$/);
    expect(id).toMatch(CLIENT_ID_RE);
    // The next page load reads it back rather than minting another.
    expect((await openTab()).browserClientId(AGENT)).toBe(id);
  });

  test("is per agent URL, so one agent's server cannot present it to another", () => {
    expect(browserClientId("http://host/agent-a/")).not.toBe(
      browserClientId("http://host/agent-b/"),
    );
  });

  test("replaces a stored value the inbox would refuse", async () => {
    const tab = await openTab();
    const first = tab.browserClientId(AGENT);
    const key = Object.keys(localStorage).find((k) => localStorage.getItem(k) === first);
    expect(key).toBeDefined();
    localStorage.setItem(key ?? "", "not a valid id!");
    const next = (await openTab()).browserClientId(AGENT);
    expect(next).toMatch(/^browser-[0-9a-f]{32}$/);
    expect(localStorage.getItem(key ?? "")).toBe(next);
  });

  test("without storage it is an id for this tab: stable in it, not shared", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const tab = await openTab();
    const id = tab.browserClientId(AGENT);
    expect(tab.browserClientId(AGENT)).toBe(id);
    expect((await openTab()).browserClientId(AGENT)).not.toBe(id);
  });
});

describe("the inbox holder is per TAB", () => {
  test("two tabs of one browser: the same client, different holders", async () => {
    const one = await openTab();
    const two = await openTab();
    expect(two.browserClientId(AGENT)).toBe(one.browserClientId(AGENT));
    expect(two.inboxHolderId(AGENT)).not.toBe(one.inboxHolderId(AGENT));
  });

  test("a holder is a valid id, stable for the tab, and names the browser", () => {
    const holder = inboxHolderId(AGENT);
    expect(holder).toMatch(CLIENT_ID_RE);
    expect(inboxHolderId(AGENT)).toBe(holder);
    expect(holder.slice(0, holder.lastIndexOf("-"))).toBe(browserClientId(AGENT));
    expect(holder).not.toBe(browserClientId(AGENT));
  });
});

describe("createSessionIdentity", () => {
  test('"auto" is this browser\'s id; a string is trimmed; a getter is asked each time', () => {
    const none = () => undefined;
    expect(createSessionIdentity({ platformUrl: AGENT, client: "auto" }, none).clientId()).toBe(
      browserClientId(AGENT),
    );
    expect(
      createSessionIdentity({ platformUrl: AGENT, client: " kitchen " }, none).clientId(),
    ).toBe("kitchen");
    let answer: string | undefined = "   ";
    const identity = createSessionIdentity({ platformUrl: AGENT, client: () => answer }, none);
    expect(identity.clientId()).toBeUndefined();
    answer = "speaker-1";
    expect(identity.clientId()).toBe("speaker-1");
    expect(createSessionIdentity({ platformUrl: AGENT }, none).clientId()).toBeUndefined();
  });
});

describe("session.identity", () => {
  test('client: "auto" sends the browser id as ?client= and reports it', () => {
    const session = createBrowserSession({
      platformUrl: AGENT,
      client: "auto",
      WebSocket: MockWebSocketConstructor,
    });
    session.start();
    const sent = new URL(lastSocket?.url ?? "").searchParams.get("client");
    expect(sent).toBe(browserClientId(AGENT));
    expect(session.identity.clientId()).toBe(sent);
    expect(session.identity.holderId()).toBe(inboxHolderId(AGENT));
    expect(session.identity.platformUrl).toBe(AGENT);
    session.disconnect();
  });

  test("an explicit client still wins, untouched", () => {
    const session = createBrowserSession({
      platformUrl: AGENT,
      client: "kitchen-speaker",
      WebSocket: MockWebSocketConstructor,
    });
    session.start();
    expect(new URL(lastSocket?.url ?? "").searchParams.get("client")).toBe("kitchen-speaker");
    expect(session.identity.clientId()).toBe("kitchen-speaker");
    session.disconnect();
  });

  test("sessionId is the CONFIRMED id: none before config, the frame's after, none after end()", () => {
    const session = createBrowserSession({
      platformUrl: AGENT,
      WebSocket: MockWebSocketConstructor,
    });
    const notified = vi.fn();
    session.subscribe(notified);
    // A resume id is a request, not a session the server has confirmed.
    session.resume("older-session");
    expect(session.identity.sessionId()).toBeUndefined();
    lastSocket?.simulateOpen();
    notified.mockClear();
    lastSocket?.simulateMessage(makeConfig(16_000, 24_000, "older-session"));
    expect(session.identity.sessionId()).toBe("older-session");
    expect(notified).toHaveBeenCalled();
    session.end();
    expect(session.identity.sessionId()).toBeUndefined();
  });
});
