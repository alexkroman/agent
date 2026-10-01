// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// What the dialer reports about the client on each attempt: `?location=`,
// `?phone=` and `?client=` are resolved per attempt, trimmed, and absent when
// blank.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MockWebSocketConstructor } from "../_session-core-test-utils.ts";
import { createBrowserSession } from "./browser-session.ts";
import { createDialer } from "./dial.ts";

const params = (socket: { url: string }) => Object.fromEntries(new URL(socket.url).searchParams);

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("createDialer client report", () => {
  test("`phone` rides on the first attempt and on the resume after it", () => {
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
      phone: "+15035550123",
    });
    expect(params(dialer.open())).toEqual({ phone: "+15035550123" });
    dialer.configured("sess-1");
    expect(params(dialer.open())).toEqual({ sessionId: "sess-1", phone: "+15035550123" });
  });

  test("a `phone` getter is asked on every attempt; blank or undefined sends none", () => {
    let phone: string | undefined = "  +15035550123 ";
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
      phone: () => phone,
    });
    expect(params(dialer.open())).toEqual({ phone: "+15035550123" });
    phone = "+442079460958";
    expect(params(dialer.open())).toEqual({ phone: "+442079460958" });
    phone = "   ";
    expect(params(dialer.open())).toEqual({});
    phone = undefined;
    expect(params(dialer.open())).toEqual({});
  });

  test("`phone` and `location` travel together, each independently optional", () => {
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
      location: "Portland, Oregon",
      phone: "+15035550123",
    });
    expect(params(dialer.open())).toEqual({ location: "Portland, Oregon", phone: "+15035550123" });
  });

  test("`client` rides on every attempt beside the others, resolved per attempt", () => {
    let client: string | undefined = " kitchen-speaker ";
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
      phone: "+15035550123",
      client: () => client,
    });
    expect(params(dialer.open())).toEqual({ phone: "+15035550123", client: "kitchen-speaker" });
    dialer.configured("sess-1");
    client = "den_speaker";
    expect(params(dialer.open())).toEqual({
      sessionId: "sess-1",
      phone: "+15035550123",
      client: "den_speaker",
    });
    client = "  ";
    expect(params(dialer.open())).toEqual({ sessionId: "sess-1", phone: "+15035550123" });
  });
});

test("the snapshot's apiUrl never carries the phone", () => {
  const session = createBrowserSession({
    platformUrl: "http://test.local",
    WebSocket: MockWebSocketConstructor,
    phone: "+15035550123",
  });
  session.connect();
  try {
    expect(session.getSnapshot().apiUrl).not.toContain("phone");
  } finally {
    session.disconnect();
  }
});
