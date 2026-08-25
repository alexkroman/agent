// Copyright 2026 the AAI authors. MIT license.
// The `aai login` device link: a signed-in (and key-onboarded) browser
// session approves a CLI-minted one-shot code, which the CLI exchanges for
// the account's stored API key. See studio-routes.ts.

import { authFetch, type TestFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";

describe("CLI device link (aai login)", () => {
  // The grammar the CLI mints: 32 random bytes, base64url (43 chars).
  const code = "A".repeat(43);
  const exchange = (fetch: TestFetch, exchangeCode = code) =>
    fetch("/studio/cli-link/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: exchangeCode }),
    });
  test("approve grants exactly one exchange for the stored key", async () => {
    const { fetch } = await withDevAuth();
    const bearer = devToken("a@b.c");
    await onboardKey(fetch, bearer);

    // Unapproved: the CLI's poll sees pending.
    expect((await exchange(fetch)).status).toBe(404);

    const approve = await authFetch(fetch, "/studio/cli-link/approve", {
      method: "POST",
      key: bearer,
      body: { code },
    });
    expect(approve.status).toBe(200);

    const granted = await exchange(fetch);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ apiKey: "users-own-key", email: "a@b.c" });
    // One-shot: a replayed exchange finds nothing.
    expect((await exchange(fetch)).status).toBe(404);
  });

  // The account this covers is the ordinary one: a key stored before the
  // `key-user:` reverse mapping existed. Its login succeeds and, without the
  // backfill, the linked CLI is scoped by the key rather than the account —
  // an empty `aai list` and "No studio project named …" for a project the
  // browser is showing.

  test("approval requires a session with a stored key", async () => {
    const { fetch } = await withDevAuth();
    const bearer = devToken("a@b.c");
    // No session at all (a raw API-key bearer is not a session).
    expect(
      (await authFetch(fetch, "/studio/cli-link/approve", { method: "POST", body: { code } }))
        .status,
    ).toBe(401);
    // Session but no key on file yet: nothing to grant.
    expect(
      (
        await authFetch(fetch, "/studio/cli-link/approve", {
          method: "POST",
          key: bearer,
          body: { code },
        })
      ).status,
    ).toBe(409);
  });

  test("rejects short (guessable) codes", async () => {
    const { fetch } = await withDevAuth();
    const bearer = devToken("a@b.c");
    await onboardKey(fetch, bearer);
    const res = await authFetch(fetch, "/studio/cli-link/approve", {
      method: "POST",
      key: bearer,
      body: { code: "short" },
    });
    expect(res.status).toBe(400);
    expect((await exchange(fetch, "short")).status).toBe(400);
  });

  test("an expired approval is refused and consumed", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = await withDevAuth();
      const bearer = devToken("a@b.c");
      await onboardKey(fetch, bearer);
      await authFetch(fetch, "/studio/cli-link/approve", {
        method: "POST",
        key: bearer,
        body: { code },
      });
      vi.advanceTimersByTime(11 * 60_000);
      expect((await exchange(fetch)).status).toBe(410);
      // The expired grant was deleted, not left redeemable.
      expect((await exchange(fetch)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});
