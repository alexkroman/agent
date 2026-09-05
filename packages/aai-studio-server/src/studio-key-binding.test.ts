// Copyright 2026 the AAI authors. MIT license.
/**
 * Who a key belongs to, and who may say so (studio-account-routes.ts).
 *
 * The `key-user:` mapping decides which studio scope a RAW-key caller lands
 * in, so whoever writes it decides where the victim's CLI pushes. It was
 * last-writer-wins, documented as benign for a shared team key — which is
 * true right up until the second writer is not a teammate.
 */

import type { ApiKeyVerifier } from "aai-server/http";
import { authFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";

describe("key ownership", () => {
  test("a second account cannot rebind a key the first already claimed", async () => {
    const { fetch } = await withDevAuth();
    const alice = devToken("alice@example.com");
    const mallory = devToken("mallory@example.com");

    expect((await onboardKey(fetch, alice, "alices-key")).status).toBe(200);

    const stolen = await onboardKey(fetch, mallory, "alices-key");
    expect(stolen.status).toBe(409);
    expect(await stolen.json()).toEqual({
      error: "That API key is already linked to another account",
    });
  });

  test("...so Alice's CLI keeps landing in Alice's scope", async () => {
    // The whole point of the 409: a rebind silently redirects every later
    // raw-key request — `aai push` writes Alice's source into Mallory's
    // workspace — and both scopes stay internally consistent, so nothing on
    // either side ever reports a problem.
    const { fetch } = await withDevAuth();
    const alice = devToken("alice@example.com");
    const mallory = devToken("mallory@example.com");

    await onboardKey(fetch, alice, "alices-key");
    await authFetch(fetch, "/studio/projects", { body: { name: "alices-app" }, key: alice });

    await onboardKey(fetch, mallory, "alices-key");
    await onboardKey(fetch, mallory, "mallorys-key");
    await authFetch(fetch, "/studio/projects", { body: { name: "mallorys-app" }, key: mallory });

    const cliView = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "alices-key" })
    ).json()) as { projects: string[] };
    expect(cliView.projects).toEqual(["alices-app"]);
  });

  test("re-saving your OWN key still works — rotation must not self-collide", async () => {
    const { fetch } = await withDevAuth();
    const alice = devToken("alice@example.com");
    expect((await onboardKey(fetch, alice, "k")).status).toBe(200);
    expect((await onboardKey(fetch, alice, "k")).status).toBe(200);
  });

  test("rotating to a fresh key is unaffected", async () => {
    const { fetch } = await withDevAuth();
    const alice = devToken("alice@example.com");
    await onboardKey(fetch, alice, "old-key");
    expect((await onboardKey(fetch, alice, "new-key")).status).toBe(200);
    const view = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "new-key" })
    ).json()) as { projects: string[] };
    expect(view.projects).toEqual([]);
  });
});

describe("key verification at onboarding", () => {
  const verifierAccepting = (...valid: string[]): ApiKeyVerifier =>
    vi.fn(async (key: string) => valid.includes(key));

  test("an unrecognized key is refused rather than stored", async () => {
    // A browser session never presents a key on the request path, so without
    // this the stored string would skip verification entirely and then BE the
    // credential for every deploy and ownership hash the account makes.
    const { fetch } = await withDevAuth({ keyVerifier: verifierAccepting("real") });
    const bearer = devToken("a@b.c");
    const res = await onboardKey(fetch, bearer, "made-up");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That is not a valid AssemblyAI API key" });
    // Refused means NOT stored — a rejected key that landed anyway would be
    // resolved by every later session request as if it had passed.
    const account = await authFetch(fetch, "/studio/account", { method: "GET", key: bearer });
    expect(await account.json()).toMatchObject({ hasKey: false });
  });

  test("a recognized key is stored", async () => {
    const { fetch } = await withDevAuth({ keyVerifier: verifierAccepting("real") });
    expect((await onboardKey(fetch, devToken("a@b.c"), "real")).status).toBe(200);
  });

  test("an unreachable verifier is 503 — never a silent store", async () => {
    const keyVerifier: ApiKeyVerifier = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const { fetch } = await withDevAuth({ keyVerifier });
    const res = await onboardKey(fetch, devToken("a@b.c"), "whatever");
    expect(res.status).toBe(503);
  });
});
