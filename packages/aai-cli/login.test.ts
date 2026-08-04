// Copyright 2026 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readGlobalConfig } from "./_config.ts";
import { CliError } from "./_output.ts";
import { executeLogin } from "./login.ts";

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  text: vi.fn(async (opts: { message: string }) =>
    opts.message.includes("code") ? "123456" : "dev@example.com",
  ),
  password: vi.fn(async () => "typed-assemblyai-key"),
}));

/** Route-keyed fake fetch; records every call. */
function fakeFetch(
  routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const route = Object.entries(routes).find(([suffixOrPath]) => url.includes(suffixOrPath));
    if (!route) return new Response(JSON.stringify({ error: `no route: ${url}` }), { status: 404 });
    const { status = 200, body } = route[1](init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  vi.clearAllMocks();
});

describe("aai login", () => {
  test("dev mode: mints a dev token, onboards the key, and saves the fetched key", async () => {
    let storedKey: string | null = null;
    const { fetchFn, calls } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "dev" } }),
      "/studio/account/key": (init) => {
        if (init?.method === "PUT") {
          storedKey = (JSON.parse(String(init.body)) as { apiKey: string }).apiKey;
          return { body: { ok: true } };
        }
        return storedKey
          ? { body: { apiKey: storedKey } }
          : { status: 404, body: { error: "none" } };
      },
      "/studio/account": () => ({ body: { hasKey: storedKey !== null } }),
    });

    const result = await executeLogin({}, { fetchFn });
    expect(result.ok).toBe(true);
    expect(storedKey).toBe("typed-assemblyai-key");
    expect((await readGlobalConfig()).apiKey).toBe("typed-assemblyai-key");

    // Every authenticated call carried the dev token, never the key.
    const authed = calls.filter((c) => c.url.includes("/studio/account"));
    for (const call of authed) {
      const header = new Headers(call.init?.headers).get("Authorization");
      expect(header).toMatch(/^Bearer dev\..+\.dev$/);
    }
  });

  test("supabase mode: email OTP send + verify, existing key fetched", async () => {
    const { fetchFn, calls } = fakeFetch({
      "/studio/auth": () => ({
        body: {
          mode: "supabase",
          supabaseUrl: "https://p.supabase.co",
          supabasePublishableKey: "sb_publishable_test",
        },
      }),
      "/auth/v1/otp": () => ({ body: {} }),
      "/auth/v1/verify": () => ({ body: { access_token: "jwt.access.token" } }),
      "/studio/account/key": () => ({ body: { apiKey: "stored-key" } }),
      "/studio/account": () => ({ body: { hasKey: true } }),
    });

    const result = await executeLogin({}, { fetchFn });
    expect(result.ok).toBe(true);
    expect((await readGlobalConfig()).apiKey).toBe("stored-key");

    const otp = calls.find((c) => c.url.endsWith("/auth/v1/otp"));
    expect(new Headers(otp?.init?.headers).get("apikey")).toBe("sb_publishable_test");
    expect(JSON.parse(String(otp?.init?.body))).toEqual({
      email: "dev@example.com",
      create_user: true,
    });
    const verify = calls.find((c) => c.url.endsWith("/auth/v1/verify"));
    expect(JSON.parse(String(verify?.init?.body))).toEqual({
      type: "email",
      email: "dev@example.com",
      token: "123456",
    });
    // Platform calls authenticate with the session, never a key.
    const account = calls.find((c) => c.url.endsWith("/studio/account"));
    expect(new Headers(account?.init?.headers).get("Authorization")).toBe(
      "Bearer jwt.access.token",
    );
  });

  test("fails cleanly when the server has no login configured", async () => {
    const { fetchFn } = fakeFetch({ "/studio/auth": () => ({ body: { mode: "none" } }) });
    await expect(executeLogin({}, { fetchFn })).rejects.toMatchObject({
      code: "login_unavailable",
    });
  });

  test("refuses without a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(executeLogin({}, fakeFetch({}))).rejects.toBeInstanceOf(CliError);
  });
});
