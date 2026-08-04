// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { requireStudioUser, resolveBearer } from "./middleware.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import {
  createDevAuth,
  createStudioAuthFromEnv,
  createSupabaseAuth,
  isJwtShaped,
  parseDevToken,
  userApiKeySecretName,
} from "./supabase-auth.ts";

/** A dev token the way the browser mints it (unpadded base64url via btoa). */
function devToken(id: string, email?: string): string {
  const payload = Buffer.from(JSON.stringify({ id, ...(email ? { email } : {}) }))
    .toString("base64url")
    .replace(/=+$/, "");
  return `dev.${payload}.dev`;
}

function bearerReq(token?: string): Request {
  return new Request("http://localhost/", {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
}

describe("isJwtShaped", () => {
  test("matches JWTs and dev tokens, never raw API keys", () => {
    expect(isJwtShaped("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-part")).toBe(true);
    expect(isJwtShaped(devToken("dev:a@b.c"))).toBe(true);
    expect(isJwtShaped("a1b2c3d4e5f6")).toBe(false);
    expect(isJwtShaped("only.two")).toBe(false);
    expect(isJwtShaped("")).toBe(false);
  });
});

describe("createSupabaseAuth", () => {
  const user = { id: "uid-1", email: "a@b.c" };

  function fakeSupabase(status: number, body?: unknown) {
    const fetchFn = vi.fn(
      async () => new Response(body === undefined ? "{}" : JSON.stringify(body), { status }),
    );
    const auth = createSupabaseAuth({
      supabaseUrl: "https://proj.supabase.co/",
      supabasePublishableKey: "sb_publishable_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    return { auth, fetchFn };
  }

  test("resolves a valid token to its user and caches the answer", async () => {
    const { auth, fetchFn } = fakeSupabase(200, user);
    expect(await auth.verifyAccessToken("tok")).toEqual(user);
    expect(await auth.verifyAccessToken("tok")).toEqual(user);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Trailing slash is stripped; the publishable key and bearer both ride along.
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/auth/v1/user");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(new Headers(init.headers).get("apikey")).toBe("sb_publishable_test");
  });

  test("401 resolves null (expired session), and negative answers cache too", async () => {
    const { auth, fetchFn } = fakeSupabase(401);
    expect(await auth.verifyAccessToken("expired")).toBeNull();
    expect(await auth.verifyAccessToken("expired")).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("a 5xx throws — Supabase being down is not a sign-out", async () => {
    const { auth } = fakeSupabase(503);
    await expect(auth.verifyAccessToken("tok")).rejects.toThrow(/503/);
  });

  test("a 200 with no user id resolves null", async () => {
    const { auth } = fakeSupabase(200, { email: "a@b.c" });
    expect(await auth.verifyAccessToken("tok")).toBeNull();
  });
});

describe("dev auth", () => {
  test("round-trips the browser-minted token shape", async () => {
    const auth = createDevAuth();
    expect(auth.clientConfig).toEqual({ mode: "dev" });
    expect(await auth.verifyAccessToken(devToken("dev:a@b.c", "a@b.c"))).toEqual({
      id: "dev:a@b.c",
      email: "a@b.c",
    });
  });

  test("rejects malformed and non-dev tokens", () => {
    expect(parseDevToken("eyJ.eyJzdWIiOiJ4In0.sig")).toBeNull();
    expect(parseDevToken("dev.!!!.dev")).toBeNull();
    expect(parseDevToken(`dev.${Buffer.from("{}").toString("base64url")}.dev`)).toBeNull();
    expect(parseDevToken("raw-api-key")).toBeNull();
  });
});

describe("createStudioAuthFromEnv", () => {
  test("Supabase env wins; local dev falls back to dev auth; else undefined", () => {
    const supa = createStudioAuthFromEnv(
      {
        SUPABASE_URL: "https://p.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      } as NodeJS.ProcessEnv,
      { localDev: true },
    );
    expect(supa?.clientConfig.mode).toBe("supabase");
    expect(
      createStudioAuthFromEnv({} as NodeJS.ProcessEnv, { localDev: true })?.clientConfig,
    ).toEqual({ mode: "dev" });
    expect(createStudioAuthFromEnv({} as NodeJS.ProcessEnv, { localDev: false })).toBeUndefined();
  });

  test("refuses dev auth when production markers are configured without explicit local dev", () => {
    // Dev auth is no auth: a deploy with real platform backing but missing
    // Supabase auth vars must fail boot, not serve mint-any-identity tokens.
    expect(() =>
      createStudioAuthFromEnv({ SUPABASE_DB_URL: "postgres://x" } as NodeJS.ProcessEnv, {
        localDev: true,
      }),
    ).toThrow("Refusing no-auth dev tokens");
    // Explicit AAI_LOCAL_DEV=1 is user intent — dev auth stays available.
    expect(
      createStudioAuthFromEnv(
        { SUPABASE_DB_URL: "postgres://x", AAI_LOCAL_DEV: "1" } as NodeJS.ProcessEnv,
        { localDev: true },
      )?.clientConfig,
    ).toEqual({ mode: "dev" });
  });
});

describe("resolveBearer", () => {
  test("raw API keys pass through untouched (the CLI's protocol)", async () => {
    const secrets = createMemorySecretStore();
    expect(await resolveBearer(bearerReq("raw-key"), { auth: createDevAuth(), secrets })).toEqual({
      apiKey: "raw-key",
    });
    // No auth binding at all: JWT-shaped bearers also pass through raw.
    expect(await resolveBearer(bearerReq("a.b.c"), { secrets })).toEqual({ apiKey: "a.b.c" });
  });

  test("session bearers resolve to the user's stored AssemblyAI key", async () => {
    const secrets = createMemorySecretStore();
    await secrets.put(userApiKeySecretName("dev:a@b.c"), "users-own-key");
    const resolved = await resolveBearer(bearerReq(devToken("dev:a@b.c")), {
      auth: createDevAuth(),
      secrets,
    });
    expect(resolved).toEqual({ apiKey: "users-own-key", userId: "dev:a@b.c" });
  });

  test("401 on an invalid session, on a session with no stored key, and on no bearer", async () => {
    const secrets = createMemorySecretStore();
    const auth = createDevAuth();
    await expect(
      resolveBearer(bearerReq("bad.session.token"), { auth, secrets }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      resolveBearer(bearerReq(devToken("dev:no-key@b.c")), { auth, secrets }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(resolveBearer(bearerReq(), { auth, secrets })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("requireStudioUser", () => {
  test("verifies the session without requiring a stored key", async () => {
    const user = await requireStudioUser(bearerReq(devToken("dev:a@b.c", "a@b.c")), {
      auth: createDevAuth(),
    });
    expect(user).toEqual({ id: "dev:a@b.c", email: "a@b.c" });
  });

  test("rejects raw keys, invalid sessions, and unconfigured auth", async () => {
    const auth = createDevAuth();
    await expect(requireStudioUser(bearerReq("raw-key"), { auth })).rejects.toMatchObject({
      status: 401,
    });
    await expect(requireStudioUser(bearerReq("bad.dev.token"), { auth })).rejects.toMatchObject({
      status: 401,
    });
    await expect(requireStudioUser(bearerReq(devToken("dev:a@b.c")), {})).rejects.toMatchObject({
      status: 401,
    });
  });
});
