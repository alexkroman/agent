// Copyright 2026 the AAI authors. MIT license.
/**
 * `closeFailure` — what a socket's CLOSE means to the person on the call.
 *
 * Two halves: the decision itself, over close events built here, and the same
 * decision as the session reports it (moved from `browser-session.test.ts`),
 * since a reason nobody surfaces is the defect this module was written for.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  resetLastSocket,
} from "../_session-core-test-utils.ts";
import { createBrowserSession } from "./browser-session.ts";
import { closeFailure } from "./close.ts";
import type { BrowserSession } from "./types.ts";

/** A close event as a browser reports one. */
function closed(code: number, reason = ""): CloseEvent {
  return new CloseEvent("close", { code, reason });
}

describe("closeFailure", () => {
  it("reports the peer's own sentence for an abnormal close", () => {
    expect(closeFailure(closed(1011, "Set ANTHROPIC_API_KEY."), false)).toBe(
      "Set ANTHROPIC_API_KEY.",
    );
  });

  it("trims the reason, and a blank one is no reason", () => {
    expect(closeFailure(closed(4001, "  slot taken  "), false)).toBe("slot taken");
    expect(closeFailure(closed(1011, "   "), false)).toBeNull();
  });

  it("a NORMAL close is an ordinary end, whatever it says", () => {
    expect(closeFailure(closed(1000, "bye"), false)).toBeNull();
  });

  it("a status-less close carries nothing to show", () => {
    expect(closeFailure(closed(1005), false)).toBeNull();
  });

  it("with no sentence, a socket that ERRORED is a connection error", () => {
    expect(closeFailure(closed(1006), true)).toBe("WebSocket connection error");
    expect(closeFailure(closed(1000, "bye"), true)).toBe("WebSocket connection error");
  });

  it("the peer's sentence beats the generic one even after a socket error", () => {
    expect(closeFailure(closed(1011, "agent crashed"), true)).toBe("agent crashed");
  });
});

describe("closeFailure, as the session reports it", () => {
  let core: BrowserSession;

  beforeEach(() => {
    resetLastSocket();
    core = createBrowserSession({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  it("a refusal close REPORTS the server's own reason", () => {
    // The guest closes 1011 with a sentence that already says what to do — a
    // missing provider credential names the variable to set. This handler used
    // to drop `event.reason` entirely, so the one thing a misconfigured
    // deployment needed to be told surfaced as a plain disconnect.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateClose(1011, "Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY.");

    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error?.message).toBe(
      "Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY.",
    );
  });

  it("a NORMAL close with a reason is still just a disconnect", () => {
    // 1000 is the caller hanging up or the server retiring a finished session;
    // showing text there would turn an ordinary ending into an error banner.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateClose(1000, "bye");

    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().error).toBe(null);
  });
});
