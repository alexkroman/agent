// Copyright 2026 the AAI authors. MIT license.
// The entitlement check behind the install callback.
//
// Most tests here are a REFUSAL, which is the point: this is the gate that
// decides whether one studio account may attach — and force-push through —
// another tenant's GitHub installation, so what matters is that it fails
// closed on every path, including the ones that are not an attack (a network
// blip, a shape GitHub did not used to send).
//
// The listing is also what RESOLVES an installation the redirect did not name,
// so a failure shape that reads as "no installations" rather than as an error
// decides a link as well as a refusal — hence the failure cases are asserted
// on the list itself, not only through the boolean.

import { describe, expect, test, vi } from "vitest";
import { testGithubApp } from "./_studio-github-test-utils.ts";
import {
  exchangeUserCode,
  listUserInstallations,
  resolveUserInstallation,
  userControlsInstallation,
} from "./studio-github-user.ts";

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

const listing = (ids: number[], total = ids.length): Response =>
  json({ total_count: total, installations: ids.map((id) => ({ id })) });

describe("listUserInstallations", () => {
  test("reports what the user administers, newest first", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => listing([7, 42]));
    expect(await listUserInstallations("tok", fetchFn)).toEqual([42, 7]);
  });

  test("the bearer is the USER token, on GitHub's installations route", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => listing([42]));
    await listUserInstallations("gho_user", fetchFn);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.github.com/user/installations");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_user");
  });

  test("every failure shape reports NOTHING, rather than throwing", async () => {
    // Empty is what both callers fail closed on: the entitlement check refuses
    // and the resolver sends the user to the install page. A partial list is
    // the one answer neither could act on, so a failed page discards the walk.
    const responses: Response[] = [
      json({ message: "Bad credentials" }, 401),
      json({}, 500),
      new Response("<html>", { status: 200 }),
      json({ total_count: 1 }),
      json({ installations: "nope" }),
    ];
    for (const response of responses) {
      const fetchFn = vi.fn<typeof globalThis.fetch>(async () => response);
      expect(await listUserInstallations("tok", fetchFn)).toEqual([]);
    }
  });

  test("a page that fails MID-WALK discards what came before it", async () => {
    const pages = [listing(Array.from({ length: 100 }, (_, i) => i + 1000)), json({}, 500)];
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => pages.shift() ?? listing([]));
    expect(await listUserInstallations("tok", fetchFn)).toEqual([]);
  });

  test("a string id that merely looks like a number is dropped", async () => {
    // Identity, not coercion: `"42" == 42` would hand an attacker a match from
    // any endpoint that stringifies ids.
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      json({ total_count: 1, installations: [{ id: "42" }] }),
    );
    expect(await listUserInstallations("tok", fetchFn)).toEqual([]);
  });

  test("walks to a second page, and stops at a short one", async () => {
    const pages = [listing(Array.from({ length: 100 }, (_, i) => i + 1000)), listing([42])];
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => pages.shift() ?? listing([]));
    expect(await listUserInstallations("tok", fetchFn)).toContain(42);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // A short page means the listing is exhausted — no further request.
    const short = vi.fn<typeof globalThis.fetch>(async () => listing([1]));
    expect(await listUserInstallations("tok", short)).toEqual([1]);
    expect(short).toHaveBeenCalledTimes(1);
  });
});

describe("userControlsInstallation", () => {
  test("true only when the id is in the user's own installations", () => {
    expect(userControlsInstallation([42, 7], 42)).toBe(true);
  });

  test("false for an installation the user does not administer", () => {
    // The escalation, at its smallest: the id is real and the token is real,
    // and they are not each other's.
    expect(userControlsInstallation([7], 42)).toBe(false);
    expect(userControlsInstallation([], 42)).toBe(false);
  });
});

describe("resolveUserInstallation", () => {
  test("the only installation, when there is one", () => {
    expect(resolveUserInstallation([42])).toBe(42);
  });

  test("nothing to link when the user administers none", () => {
    // Not a refusal: the caller sends them to the install page, which is what
    // this state means.
    expect(resolveUserInstallation([])).toBeUndefined();
  });

  test("the NEWEST of several, since one link per account is the model", () => {
    // The list arrives id-descending, and ids increase with creation.
    expect(resolveUserInstallation([99, 42, 7])).toBe(99);
  });
});
