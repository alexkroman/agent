// Copyright 2026 the AAI authors. MIT license.
/**
 * Who a key belongs to, and who may say so (studio-account-routes.ts).
 *
 * The `key-user:` mapping decides which studio scope a RAW-key caller lands
 * in, so whoever writes it decides where the victim's CLI pushes. It was
 * last-writer-wins, documented as benign for a shared team key — which is
 * true right up until the second writer is not a teammate.
 */

import type { ApiKeyVerifier } from "aai-server/api-key-verify";
import { createDevAuth } from "aai-server/supabase-auth";
import { authFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";

const token = (email: string) =>
  `dev.${Buffer.from(JSON.stringify({ id: `dev:${email}`, email }))
    .toString("base64url")
    .replace(/=+$/, "")}.dev`;

const putKey = (
  fetch: Awaited<ReturnType<typeof createTestCombined>>["fetch"],
  bearer: string,
  apiKey: string,
) => authFetch(fetch, "/studio/account/key", { method: "PUT", key: bearer, body: { apiKey } });

describe("key ownership", () => {
  test("a second account cannot rebind a key the first already claimed", async () => {
    const { fetch } = await createTestCombined({ auth: createDevAuth() });
    const alice = token("alice@example.com");
    const mallory = token("mallory@example.com");

    expect((await putKey(fetch, alice, "alices-key")).status).toBe(200);

    const stolen = await putKey(fetch, mallory, "alices-key");
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
    const { fetch } = await createTestCombined({ auth: createDevAuth() });
    const alice = token("alice@example.com");
    const mallory = token("mallory@example.com");

    await putKey(fetch, alice, "alices-key");
    await authFetch(fetch, "/studio/projects", { body: { name: "alices-app" }, key: alice });

    await putKey(fetch, mallory, "alices-key");
    await putKey(fetch, mallory, "mallorys-key");
    await authFetch(fetch, "/studio/projects", { body: { name: "mallorys-app" }, key: mallory });

    const cliView = (await (
      await authFetch(fetch, "/studio/projects", { method: "GET", key: "alices-key" })
    ).json()) as { projects: string[] };
    expect(cliView.projects).toEqual(["alices-app"]);
  });

  test("re-saving your OWN key still works — rotation must not self-collide", async () => {
    const { fetch } = await createTestCombined({ auth: createDevAuth() });
    const alice = token("alice@example.com");
    expect((await putKey(fetch, alice, "k")).status).toBe(200);
    expect((await putKey(fetch, alice, "k")).status).toBe(200);
  });

  test("rotating to a fresh key is unaffected", async () => {
    const { fetch } = await createTestCombined({ auth: createDevAuth() });
    const alice = token("alice@example.com");
    await putKey(fetch, alice, "old-key");
    expect((await putKey(fetch, alice, "new-key")).status).toBe(200);
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
    const { fetch } = await createTestCombined({
      auth: createDevAuth(),
      keyVerifier: verifierAccepting("real"),
    });
    const bearer = token("a@b.c");
    const res = await putKey(fetch, bearer, "made-up");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That is not a valid AssemblyAI API key" });
    // Refused means NOT stored — a rejected key that landed anyway would be
    // resolved by every later session request as if it had passed.
    const account = await authFetch(fetch, "/studio/account", { method: "GET", key: bearer });
    expect(await account.json()).toMatchObject({ hasKey: false });
  });

  test("a recognized key is stored", async () => {
    const { fetch } = await createTestCombined({
      auth: createDevAuth(),
      keyVerifier: verifierAccepting("real"),
    });
    expect((await putKey(fetch, token("a@b.c"), "real")).status).toBe(200);
  });

  test("an unreachable verifier is 503 — never a silent store", async () => {
    const keyVerifier: ApiKeyVerifier = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const { fetch } = await createTestCombined({ auth: createDevAuth(), keyVerifier });
    const res = await putKey(fetch, token("a@b.c"), "whatever");
    expect(res.status).toBe(503);
  });
});
