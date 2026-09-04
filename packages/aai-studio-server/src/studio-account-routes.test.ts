// Copyright 2026 the AAI authors. MIT license.
// The browser-session account surface (studio-account-routes.ts): sign-in
// config, key onboarding, the `aai login` device link, and how sessions and
// raw keys resolve to one studio scope.

import { authFetch } from "aai-server/test-utils";
import { describe, expect, test } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";
import { createProject } from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";

describe("browser sessions", () => {
  test("GET /studio/auth reports the login mode — 'none' when unconfigured", async () => {
    const plain = await createTestCombined();
    expect(await (await plain.fetch("/studio/auth")).json()).toEqual({ mode: "none" });
    const { fetch } = await withDevAuth();
    expect(await (await fetch("/studio/auth")).json()).toEqual({ mode: "dev" });
  });

  test("account routes: no key on file until the onboarding PUT stores one", async () => {
    const { fetch } = await withDevAuth();
    const bearer = devToken("a@b.c");
    const before = await authFetch(fetch, "/studio/account", { method: "GET", key: bearer });
    expect(await before.json()).toEqual({ email: "a@b.c", hasKey: false });

    expect((await onboardKey(fetch, bearer)).status).toBe(200);
    const after = await authFetch(fetch, "/studio/account", { method: "GET", key: bearer });
    expect(await after.json()).toEqual({ email: "a@b.c", hasKey: true });
  });

  test("account routes reject raw API keys and invalid sessions", async () => {
    const { fetch } = await withDevAuth();
    expect(
      (await authFetch(fetch, "/studio/account", { method: "GET", key: "raw-key" })).status,
    ).toBe(401);
    expect(
      (await authFetch(fetch, "/studio/account", { method: "GET", key: "bad.dev.token" })).status,
    ).toBe(401);
  });

  test("a session token that looks like a JWT is rejected on key onboarding", async () => {
    const { fetch } = await withDevAuth();
    const res = await onboardKey(fetch, devToken("a@b.c"), "looks.like.jwt");
    expect(res.status).toBe(400);
  });

  test("project routes resolve the session to the stored key; 401 before onboarding", async () => {
    const { fetch } = await withDevAuth();
    const bearer = devToken("a@b.c");
    // Before the key is stored: project routes refuse the session.
    const early = await authFetch(fetch, "/studio/projects", { method: "GET", key: bearer });
    expect(early.status).toBe(401);

    await onboardKey(fetch, bearer);
    await createProject(fetch, "mine", bearer);
    const listed = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: bearer })
    ).json()) as { projects: string[] };
    expect(listed.projects).toEqual(["mine"]);

    // The account's own key resolves to the SAME user scope (the key→user
    // reverse mapping written by the onboarding PUT): a linked CLI sees the
    // browser's projects, which is what makes `aai pull`/`aai push` work.
    const rawView = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "users-own-key" })
    ).json()) as { projects: string[] };
    expect(rawView.projects).toEqual(["mine"]);

    // An unrelated raw key (never stored via the account route) keeps the
    // its own key-derived scope — its own empty namespace, never the user's.
    const strangerView = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "some-other-key" })
    ).json()) as { projects: string[] };
    expect(strangerView.projects).toEqual([]);
  });
});
