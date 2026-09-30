// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { recordSessionIdentity, writeSessionEntry } from "./_session-identity-store.ts";
import { sessionCall } from "./session-call.ts";
import { sessionClientId } from "./session-client.ts";
import { sessionClientLocation } from "./session-location.ts";
import { sessionClientPhone } from "./session-phone.ts";

describe("recordSessionIdentity", () => {
  test("records every field in one call, each read back by its own reader", () => {
    const ctx = { sessionId: "identity-a" };
    recordSessionIdentity(ctx.sessionId, {
      clientId: "kitchen",
      location: "  1 Main St,\n Springfield ",
      phone: "+1 (503) 555-0123",
      call: { carrier: "twilio", parameters: { call: "c_1" } },
    });
    expect(sessionClientId(ctx)).toBe("kitchen");
    expect(sessionClientLocation(ctx)).toBe("1 Main St, Springfield");
    expect(sessionClientPhone(ctx)).toBe("+15035550123");
    expect(sessionCall(ctx)?.parameters).toEqual({ call: "c_1" });
    expect(Object.isFrozen(sessionCall(ctx)?.parameters)).toBe(true);
  });

  test("a field the rule refuses, or leaves out, keeps what was recorded before", () => {
    const ctx = { sessionId: "identity-b" };
    recordSessionIdentity(ctx.sessionId, { location: "2 Elm St", phone: "+15035550100" });
    recordSessionIdentity(ctx.sessionId, { location: "x".repeat(201), phone: "5035550199" });
    expect(sessionClientLocation(ctx)).toBe("2 Elm St");
    expect(sessionClientPhone(ctx)).toBe("+15035550100");
    recordSessionIdentity(ctx.sessionId, {});
    expect(sessionClientPhone(ctx)).toBe("+15035550100");
  });
});

describe("writeSessionEntry", () => {
  test("a rewrite is the newest, and the oldest is evicted past the cap", () => {
    const map = new Map<string, number>();
    writeSessionEntry(map, "a", 1, 2);
    writeSessionEntry(map, "b", 2, 2);
    writeSessionEntry(map, "a", 3, 2);
    writeSessionEntry(map, "c", 4, 2);
    expect([...map]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});
