// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `useSessionId` and `useClientId` over a REAL session core with a mock socket:
 * the session id appears with the `config` frame (not with a resume request),
 * follows a resume onto the resumed session's id, and is gone after `end()`;
 * the client id is what the session sends, `"auto"` included.
 */

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderHookWithSession } from "./_react-test-utils.ts";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { browserClientId } from "./client-identity.ts";
import { createBrowserSession } from "./session/index.ts";
import type { VoiceSessionOptions } from "./types.ts";
import { useClientId, useSessionId } from "./use-session-id.ts";

const AGENT = "http://localhost:3000/";

function mount<T>(hook: () => T, options: Partial<VoiceSessionOptions> = {}) {
  const session = createBrowserSession({
    platformUrl: AGENT,
    WebSocket: MockWebSocketConstructor,
    ...options,
  });
  const rendered = renderHookWithSession(hook, session);
  return { session, rendered };
}

/** A completed handshake announcing `sid`. */
function configure(sid: string): void {
  act(() => {
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig(16_000, 24_000, sid));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLastSocket();
});

describe("useSessionId", () => {
  test("undefined until the config frame, then the server's id", () => {
    const { session, rendered } = mount(useSessionId);
    expect(rendered.result.current).toBeUndefined();
    act(() => session.start());
    expect(rendered.result.current).toBeUndefined();
    configure("sess-1");
    expect(rendered.result.current).toBe("sess-1");
    session.disconnect();
  });

  test("follows a resume onto the resumed session, and a new session onto its own", () => {
    const { session, rendered } = mount(useSessionId);
    act(() => session.start());
    configure("sess-1");
    act(() => session.resume("sess-0"));
    expect(rendered.result.current).toBeUndefined();
    configure("sess-0");
    expect(rendered.result.current).toBe("sess-0");
    act(() => session.restart());
    configure("sess-2");
    expect(rendered.result.current).toBe("sess-2");
    session.disconnect();
  });

  test("a hang-up keeps it (the session can resume); end() clears it", () => {
    const { session, rendered } = mount(useSessionId);
    act(() => session.start());
    configure("sess-1");
    act(() => session.disconnect());
    expect(rendered.result.current).toBe("sess-1");
    act(() => session.end());
    expect(rendered.result.current).toBeUndefined();
  });
});

describe("useClientId", () => {
  test('"auto" is this browser\'s id', () => {
    const { rendered } = mount(useClientId, { client: "auto" });
    expect(rendered.result.current).toBe(browserClientId(AGENT));
    expect(rendered.result.current).toMatch(/^browser-[0-9a-f]{32}$/);
  });

  test("an explicit client is reported as sent, and none is undefined", () => {
    expect(mount(useClientId, { client: " kitchen " }).rendered.result.current).toBe("kitchen");
    expect(mount(useClientId).rendered.result.current).toBeUndefined();
  });
});
