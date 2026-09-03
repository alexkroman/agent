// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { requireStudioUser, resolveBearer } from "./middleware.ts";
import { PlatformServiceUnavailableError } from "./platform-service-errors.ts";
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
  const JWKS_PATH = "/auth/v1/.well-known/jwks.json";

  /**
   * A fresh project URL per test. auth-js caches a project's JWKS
   * PROCESS-WIDE, keyed by URL — which is exactly what makes local
   * verification cheap in production, and what makes tests sharing one URL
   * verify against whichever key the first test happened to publish.
   */
  let projectCount = 0;
  const nextProjectUrl = () => {
    projectCount += 1;
    return `https://proj-${projectCount}.supabase.co`;
  };

  /** A signing key plus the JWKS a project would publish for it. */
  async function signingKey(kid = "kid-1") {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return {
      privateKey: pair.privateKey,
      kid,
      jwks: { keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] },
    };
  }

  /**
   * A real ES256-signed access token, the shape Supabase issues on a project
   * with asymmetric JWT signing keys. Signed for real so the verification
   * under test is real: a stub would pass whatever it was handed.
   */
  async function signToken(
    key: Awaited<ReturnType<typeof signingKey>>,
    claims: Record<string, unknown>,
    issuer = "https://proj.supabase.co",
  ): Promise<string> {
    const seg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const input = `${seg({ alg: "ES256", typ: "JWT", kid: key.kid })}.${seg({
      iss: `${issuer}/auth/v1`,
      aud: "authenticated",
      role: "authenticated",
      iat: now,
      exp: now + 3600,
      ...claims,
    })}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  }

  /** Routes the two endpoints auth-js may reach: JWKS discovery, and /user. */
  function fakeSupabase(opts: {
    jwks?: unknown;
    userStatus?: number;
    userBody?: unknown;
    jwksStatus?: number;
    jwksThrows?: boolean;
    url?: string;
  }) {
    const fetchFn = vi.fn(async (input: unknown) => {
      const requested = String(input);
      if (requested.includes(".well-known/jwks.json")) {
        if (opts.jwksThrows) throw new TypeError("fetch failed");
        return new Response(JSON.stringify(opts.jwks ?? { keys: [] }), {
          status: opts.jwksStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(opts.userBody === undefined ? "{}" : JSON.stringify(opts.userBody), {
        status: opts.userStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const url = opts.url ?? nextProjectUrl();
    const auth = createSupabaseAuth({
      supabaseUrl: `${url}/`,
      supabasePublishableKey: "sb_publishable_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    return { auth, fetchFn, url };
  }

  const requestedUser = (fetchFn: { mock: { calls: unknown[][] } }) =>
    fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/auth/v1/user"));

  // ── The hot path: local signature verification ────────────────────────────

  test("verifies a token's signature against the project JWKS, no /user call", async () => {
    const key = await signingKey();
    const { auth, fetchFn, url } = fakeSupabase({ jwks: key.jwks });
    const token = await signToken(key, { sub: user.id, email: user.email }, url);

    expect(await auth.verifyAccessToken(token)).toEqual(user);
    // The whole point of preferring getClaims: the Auth server is never asked.
    expect(requestedUser(fetchFn)).toEqual([]);
    expect(fetchFn.mock.calls.some(([input]) => String(input).endsWith(JWKS_PATH))).toBe(true);
  });

  test("rejects a token signed by a key the project does not publish", async () => {
    // The assertion that makes the one above mean something: the verification
    // is a real signature check, not a decode.
    const projectKey = await signingKey();
    const attackerKey = await signingKey(projectKey.kid);
    const { auth, url } = fakeSupabase({ jwks: projectKey.jwks });
    const forged = await signToken(attackerKey, { sub: "someone-else" }, url);

    expect(await auth.verifyAccessToken(forged)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const key = await signingKey();
    const { auth, url } = fakeSupabase({ jwks: key.jwks });
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await signToken(key, { sub: user.id, exp: past, iat: past - 3600 }, url);

    expect(await auth.verifyAccessToken(token)).toBeNull();
  });

  test("caches both answers, so a repeat costs no verification at all", async () => {
    const key = await signingKey();
    const { auth, fetchFn, url } = fakeSupabase({ jwks: key.jwks });
    const token = await signToken(key, { sub: user.id, email: user.email }, url);

    expect(await auth.verifyAccessToken(token)).toEqual(user);
    const afterFirst = fetchFn.mock.calls.length;
    expect(await auth.verifyAccessToken(token)).toEqual(user);
    expect(await auth.verifyAccessToken("not.a.jwt")).toBeNull();
    expect(await auth.verifyAccessToken("not.a.jwt")).toBeNull();
    expect(fetchFn.mock.calls.length).toBe(afterFirst);
  });

  /**
   * `getClaims` validates `exp` — but only on a cache MISS, so a flat 60s
   * entry keeps serving a token that expired 59 seconds ago. The cache TTL
   * and the token's lifetime have to be a minimum, not a sum.
   */
  test("a cached verification never outlives the token's own exp", async () => {
    const key = await signingKey();
    const { auth, url } = fakeSupabase({ jwks: key.jwks });
    const now = Math.floor(Date.now() / 1000);
    // Expires well inside the verify cache's own TTL, which is the case a
    // flat TTL gets wrong.
    const token = await signToken(key, { sub: user.id, iat: now, exp: now + 5 }, url);

    expect(await auth.verifyAccessToken(token)).toEqual({ id: user.id });

    // Fake timers installed only for the jump: everything above signs and
    // verifies for real, and the crypto has already settled.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10_000);
      // The entry expired with the token, so this re-verifies — and a
      // re-verification of an expired token is a rejection.
      expect(await auth.verifyAccessToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an unreachable Supabase throws rather than signing the user out", async () => {
    // A rejected token and an unreachable JWKS endpoint are opposite answers,
    // and only one of them should end a session. This is also the one failure
    // that must not be cached as a rejection.
    const key = await signingKey();
    const { auth, url } = fakeSupabase({ jwks: key.jwks, jwksThrows: true });
    const token = await signToken(key, { sub: user.id }, url);

    await expect(auth.verifyAccessToken(token)).rejects.toThrow(/Supabase auth verification/);
  });

  // ── The account routes: server-verified, uncached ─────────────────────────

  test("the fresh check asks the Auth server every time", async () => {
    // Pinned URL: this test asserts the exact endpoint and headers.
    const { auth, fetchFn } = fakeSupabase({ userBody: user, url: "https://proj.supabase.co" });
    expect(await auth.verifyAccessTokenFresh("tok")).toEqual(user);
    expect(await auth.verifyAccessTokenFresh("tok")).toEqual(user);
    // Uncached on purpose: its whole job is to see a revoked session at once.
    expect(requestedUser(fetchFn)).toHaveLength(2);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash is stripped; the publishable key and bearer both ride along.
    expect(url).toBe("https://proj.supabase.co/auth/v1/user");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(new Headers(init.headers).get("apikey")).toBe("sb_publishable_test");
  });

  test("the fresh check reports 401 as null and 5xx as a throw", async () => {
    expect(
      await fakeSupabase({ userStatus: 401 }).auth.verifyAccessTokenFresh("expired"),
    ).toBeNull();
    await expect(
      fakeSupabase({ userStatus: 503 }).auth.verifyAccessTokenFresh("tok"),
    ).rejects.toThrow(/503/);
    // A 200 naming no user is not a session either.
    expect(
      await fakeSupabase({ userBody: { email: "a@b.c" } }).auth.verifyAccessTokenFresh("tok"),
    ).toBeNull();
  });

  /**
   * "Throws" was never the whole contract — WHAT it throws decides the status.
   *
   * `GET /studio/account` answered `500 Internal server error` six times in one
   * production hour while GoTrue returned 500 for want of a database
   * connection. So the one route that reports who you are told a signed-in user
   * the platform was broken, beside sibling routes correctly answering 503 for
   * the same root cause — and the studio client, which retries 5xx, spent its
   * retries on a status that says not to.
   */
  test("a 5xx from the Auth server is UNAVAILABLE, so the surface answers 503", async () => {
    const err = await fakeSupabase({ userStatus: 500 })
      .auth.verifyAccessTokenFresh("tok")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformServiceUnavailableError);
    expect((err as PlatformServiceUnavailableError).service).toBe("supabase-auth");
  });

  test("a 400 from the Auth server stays a server fault, because a retry cannot fix it", async () => {
    // The line that keeps 503 meaningful: a 4xx will fail identically on
    // retry. 401/403 are neither — they are "signed out", asserted above.
    const err = await fakeSupabase({ userStatus: 400 })
      .auth.verifyAccessTokenFresh("tok")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PlatformServiceUnavailableError);
  });

  test("an unreachable Auth server is UNAVAILABLE too, not merely a throw", async () => {
    const key = await signingKey();
    const { auth, url } = fakeSupabase({ jwks: key.jwks, jwksThrows: true });
    const token = await signToken(key, { sub: user.id }, url);

    await expect(auth.verifyAccessToken(token)).rejects.toBeInstanceOf(
      PlatformServiceUnavailableError,
    );
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
  const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;
  const SUPABASE = {
    SUPABASE_URL: "https://p.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  };

  test("Supabase env wins over every other consideration", () => {
    expect(createStudioAuthFromEnv(env(SUPABASE))?.clientConfig.mode).toBe("supabase");
    // Including on a declared local run against a platform database, which is
    // the whole shape `pnpm dev:aai-server` now resolves.
    expect(
      createStudioAuthFromEnv(
        env({ ...SUPABASE, AAI_LOCAL_DEV: "1", SUPABASE_DB_URL: "postgres://x" }),
      )?.clientConfig.mode,
    ).toBe("supabase");
  });

  test("dev auth needs an explicit local-dev declaration and no platform database", () => {
    expect(createStudioAuthFromEnv(env({ AAI_LOCAL_DEV: "1" }))?.clientConfig).toEqual({
      mode: "dev",
    });
    // Neither declared nor configured: raw-key bearers keep working, the studio
    // login is simply unavailable.
    expect(createStudioAuthFromEnv(env({}))).toBeUndefined();
  });

  test("a platform database refuses dev tokens, declaration or not", () => {
    // Dev auth is NO auth, and `user-key:<uid>` is where every account's
    // AssemblyAI key lives — so serving it against real stores lets any caller
    // claim any user id and read that key. There is deliberately no escape: the
    // `AAI_LOCAL_DEV=1` one used to make this reachable on purpose.
    for (const extra of [{}, { AAI_LOCAL_DEV: "1" }]) {
      expect(() =>
        createStudioAuthFromEnv(env({ SUPABASE_DB_URL: "postgres://x", ...extra })),
      ).toThrow("SUPABASE_DB_URL is set but Supabase auth is not");
    }
  });

  test("the refusal names both ways out", () => {
    // A boot failure whose message does not say what to do is a boot failure
    // somebody works around by reverting.
    expect(() => createStudioAuthFromEnv(env({ SUPABASE_DB_URL: "postgres://x" }))).toThrow(
      /pnpm dev:aai-server|unset SUPABASE_DB_URL/,
    );
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
