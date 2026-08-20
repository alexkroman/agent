// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import {
  assertGuestTokenSecret,
  GUEST_TOKEN_SECRET_ENV,
  guestTokenFor,
  resetGuestTokenKey,
} from "./guest-token.ts";
import { captureLogs } from "./test-utils.ts";

const SECRET = { [GUEST_TOKEN_SECRET_ENV]: "shared-platform-secret" };

afterEach(() => {
  resetGuestTokenKey();
});

describe("guestTokenFor", () => {
  test("is reproducible from the name — the property the whole change exists for", () => {
    // Two REPLICAS holding the same secret compute the same token for one
    // sandbox, which is what lets a replica that did not spawn it read its
    // logs. Modelled here as two independent calls, because that is all a
    // second replica is.
    expect(guestTokenFor("agent-abc-v1", SECRET)).toBe(guestTokenFor("agent-abc-v1", SECRET));
  });

  test("differs per sandbox name, so one leaked token opens no other guest", () => {
    expect(guestTokenFor("agent-abc-v1", SECRET)).not.toBe(guestTokenFor("agent-def-v1", SECRET));
  });

  test("rotates on redeploy, because the version is half the name", () => {
    expect(guestTokenFor("agent-abc-v1", SECRET)).not.toBe(guestTokenFor("agent-abc-v2", SECRET));
  });

  test("is unguessable without the secret — a different key gives a different token", () => {
    expect(guestTokenFor("agent-abc-v1", SECRET)).not.toBe(
      guestTokenFor("agent-abc-v1", { [GUEST_TOKEN_SECRET_ENV]: "someone else's secret" }),
    );
  });

  test("is 64 hex characters, like the random one it replaced", () => {
    expect(guestTokenFor("agent-abc-v1", SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("falls back to a per-process key when the secret is unset", () => {
    // Still unguessable and still per-sandbox — only the CROSS-REPLICA property
    // is given up, which is exactly what the boot warning reports.
    const a = guestTokenFor("agent-abc-v1", {});
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(guestTokenFor("agent-abc-v1", {})).toBe(a);
    expect(guestTokenFor("agent-def-v1", {})).not.toBe(a);
  });

  test("an empty secret is treated as unset, not as a key", () => {
    expect(guestTokenFor("agent-abc-v1", { [GUEST_TOKEN_SECRET_ENV]: "" })).not.toBe(
      guestTokenFor("agent-abc-v1", SECRET),
    );
  });

  test("a nameless sandbox gets a random token rather than a shared one", () => {
    // The studio warm harness, spawned outside the naming path: there is no
    // fleet-wide identity to derive from, so two of them must not collide.
    expect(guestTokenFor(undefined, SECRET)).not.toBe(guestTokenFor(undefined, SECRET));
  });
});

describe("assertGuestTokenSecret", () => {
  const logs = captureLogs();

  test("warns when a multi-replica deployment has no shared secret", () => {
    assertGuestTokenSecret({}, true);
    expect(logs.warns()).toEqual([expect.stringContaining(GUEST_TOKEN_SECRET_ENV)]);
  });

  test("says nothing when the secret is set", () => {
    assertGuestTokenSecret(SECRET, true);
    expect(logs.warns()).toEqual([]);
  });

  test("says nothing without a platform database — a single process has no peer", () => {
    assertGuestTokenSecret({}, false);
    expect(logs.warns()).toEqual([]);
  });
});
