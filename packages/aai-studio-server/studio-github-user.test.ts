// Copyright 2026 the AAI authors. MIT license.
// The entitlement check behind the install callback.
//
// Every test here is a REFUSAL except the first, which is the point: this is
// the gate that decides whether one studio account may attach — and force-push
// through — another tenant's GitHub installation, so what matters is that it
// fails closed on every path, including the ones that are not an attack (a
// network blip, a shape GitHub did not used to send).

import { describe, expect, test, vi } from "vitest";
import { testGithubApp } from "./_studio-github-test-utils.ts";
import { exchangeUserCode, userControlsInstallation } from "./studio-github-user.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("exchangeUserCode", () => {
  test("returns the token GitHub answers with", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      json({ access_token: "gho_token", token_type: "bearer" }),
    );
    expect(await exchangeUserCode(testGithubApp, "code-1", fetchFn)).toBe("gho_token");

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    // The client SECRET is what makes the code redeemable by us and nobody
    // else, so it has to actually be sent.
    expect(JSON.parse(String(init?.body))).toMatchObject({
      client_id: testGithubApp.clientId,
      client_secret: testGithubApp.clientSecret,
      code: "code-1",
    });
  });

  test("a rejected code is null, even though GitHub answers 200", async () => {
    // The trap: GitHub reports a bad or replayed code as `200 { error }`, so
    // the status is not the test — the presence of a token is.
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: "bad_verification_code" }),
    );
    expect(await exchangeUserCode(testGithubApp, "used", fetchFn)).toBeNull();
  });

  test("a non-2xx, an unparsable body, and an empty token are all null", async () => {
    const cases: Response[] = [
      json({ access_token: "x" }, 500),
      new Response("<html>", { status: 200 }),
      json({ access_token: "" }),
      json(["not", "an", "object"]),
    ];
    for (const response of cases) {
      const fetchFn = vi.fn<typeof globalThis.fetch>(async () => response);
      expect(await exchangeUserCode(testGithubApp, "c", fetchFn)).toBeNull();
    }
  });
});

describe("userControlsInstallation", () => {
  const listing = (ids: number[], total = ids.length): Response =>
    json({ total_count: total, installations: ids.map((id) => ({ id })) });

  test("true only when the id is in the user's own installations", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => listing([7, 42]));
    expect(await userControlsInstallation("tok", 42, fetchFn)).toBe(true);
  });

  test("false for an installation the user does not administer", async () => {
    // The escalation, at its smallest: the id is real and the token is real,
    // and they are not each other's.
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => listing([7]));
    expect(await userControlsInstallation("tok", 42, fetchFn)).toBe(false);
  });

  test("the bearer is the USER token, on GitHub's installations route", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => listing([42]));
    await userControlsInstallation("gho_user", 42, fetchFn);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.github.com/user/installations");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_user");
  });

  test("every failure shape fails CLOSED", async () => {
    // "We could not confirm" and "you do not control it" call for the same
    // refusal, so each of these must be false rather than throwing or passing.
    const responses: Response[] = [
      json({ message: "Bad credentials" }, 401),
      json({}, 500),
      new Response("<html>", { status: 200 }),
      json({ total_count: 1 }),
      json({ installations: "nope" }),
    ];
    for (const response of responses) {
      const fetchFn = vi.fn<typeof globalThis.fetch>(async () => response);
      expect(await userControlsInstallation("tok", 42, fetchFn)).toBe(false);
    }
  });

  test("a string id that merely looks like the number does not match", async () => {
    // Identity, not coercion: `"42" == 42` would hand an attacker a match from
    // any endpoint that stringifies ids.
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      json({ total_count: 1, installations: [{ id: "42" }] }),
    );
    expect(await userControlsInstallation("tok", 42, fetchFn)).toBe(false);
  });

  test("walks to a second page, and stops at a short one", async () => {
    // A full first page that does NOT contain the target, so the walk has to
    // reach the second one to find it.
    const pages = [listing(Array.from({ length: 100 }, (_, i) => i + 1000)), listing([42])];
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => pages.shift() ?? listing([]));
    expect(await userControlsInstallation("tok", 42, fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // A short page means the listing is exhausted — no further request.
    const short = vi.fn<typeof globalThis.fetch>(async () => listing([1]));
    expect(await userControlsInstallation("tok", 42, short)).toBe(false);
    expect(short).toHaveBeenCalledTimes(1);
  });
});
