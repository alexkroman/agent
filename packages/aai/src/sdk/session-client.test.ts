// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import { sessionClientId, setSessionClient } from "./session-client.ts";

afterEach(() => vi.useRealTimers());

describe("sessionClientId", () => {
  test("answers the id recorded for the session, and undefined for any other", () => {
    setSessionClient("sess-a", "kitchen");
    expect(sessionClientId({ sessionId: "sess-a" })).toBe("kitchen");
    expect(sessionClientId({ sessionId: "sess-unknown" })).toBeUndefined();
  });

  test("a later record for the same session replaces the earlier one", () => {
    setSessionClient("sess-b", "one");
    setSessionClient("sess-b", "two");
    expect(sessionClientId({ sessionId: "sess-b" })).toBe("two");
  });

  test("the store is shared through globalThis, so a second copy of the module reads it", () => {
    // What a second copy of this module (the agent bundle's) would find.
    setSessionClient("sess-c", "hall");
    const store = (globalThis as Record<symbol, Map<string, { clientId: string }> | undefined>)[
      Symbol.for("@alexkroman1/aai.sessionClients")
    ];
    expect(store?.get("sess-c")?.clientId).toBe("hall");
  });

  test("an entry expires after a day", () => {
    vi.useFakeTimers();
    setSessionClient("sess-d", "den");
    vi.advanceTimersByTime(86_400_001);
    expect(sessionClientId({ sessionId: "sess-d" })).toBeUndefined();
  });

  test("createToolContext({ clientId }) seeds it for the context's session, and only that one", () => {
    expect(sessionClientId(createToolContext({ clientId: "porch" }))).toBe("porch");
    expect(sessionClientId(createToolContext())).toBeUndefined();
  });
});
