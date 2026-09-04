// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readGlobalConfig } from "./_config.ts";
import { CliError } from "./_output.ts";
import { executeLogin } from "./login.ts";

// The default browser opener spawns the platform's opener command; stub it
// so tests never launch a real browser, and exercise its swallowed-error
// path (a missing opener must not fail the login — the URL is printed).
const spawnMock = vi.fn(() => {
  const child = {
    on(_event: string, cb: (err: Error) => void) {
      cb(new Error("opener not installed"));
      return child;
    },
    unref() {
      // Detached-child bookkeeping — nothing to observe.
    },
  };
  return child;
});
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...(args as [])),
}));

/** Route-keyed fake fetch; records every call. */
/**
 * Narrow a partial `fetch` mock to `typeof fetch` — this file's ONE seam.
 *
 * The mocks below take only the arguments they care about (`input`, or none
 * at all) and return `Promise<Response>` or a rejection, which is not
 * assignable to `typeof fetch`'s full overloaded signature. Widening once
 * here keeps the escape-hatch count at 1 for the file rather than one per
 * call site; `fakeFetch` above needs no cast because it is written to the
 * real signature.
 */
function asFetch(fn: (...args: never[]) => unknown): typeof fetch {
  return fn as unknown as typeof fetch;
}

function fakeFetch(
  routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...omitUndefined({ init }) });
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
  test("links a signed-in browser account: opens the studio and polls exchange", async () => {
    let exchanges = 0;
    const { fetchFn, calls } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "supabase" } }),
      "/studio/cli-link/exchange": () =>
        // Pending until the (simulated) browser approval lands.
        ++exchanges < 3
          ? { status: 404, body: { pending: true } }
          : { body: { apiKey: "linked-key", email: "dev@example.com" } },
    });
    const openBrowser = vi.fn();

    const result = await executeLogin({}, { fetchFn, openBrowser, pollIntervalMs: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.email).toBe("dev@example.com");
    expect((await readGlobalConfig()).apiKey).toBe("linked-key");

    // The browser is pointed at the studio with the SAME code the CLI polls
    // with — the code is the whole handshake.
    expect(openBrowser).toHaveBeenCalledOnce();
    const linkUrl = new URL(openBrowser.mock.calls[0]?.[0] as string);
    const code = linkUrl.searchParams.get("cli-link");
    expect(code).toMatch(/^[\w-]{40,}$/);
    const exchange = calls.find((c) => c.url.endsWith("/studio/cli-link/exchange"));
    expect(JSON.parse(String(exchange?.init?.body))).toEqual({ code });
    // The CLI never signs in: no Supabase, account, or key routes are hit.
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/auth/v1/") || u.includes("/studio/account"))).toBe(false);
  });

  test("dev mode links the same way (the browser handles sign-in)", async () => {
    const { fetchFn } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "dev" } }),
      "/studio/cli-link/exchange": () => ({ body: { apiKey: "dev-linked-key" } }),
    });
    const result = await executeLogin({}, { fetchFn, openBrowser: vi.fn(), pollIntervalMs: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.email).toBe("your account");
    expect((await readGlobalConfig()).apiKey).toBe("dev-linked-key");
  });

  test("opens the system browser by default; a failed opener is not fatal", async () => {
    const { fetchFn } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "supabase" } }),
      "/studio/cli-link/exchange": () => ({ body: { apiKey: "linked-key" } }),
    });
    // No openBrowser seam: the real (spawn-backed) opener runs, its spawn
    // error is swallowed, and the poll still completes the login.
    const result = await executeLogin({}, { fetchFn, pollIntervalMs: 1 });
    expect(result.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  test("an unreachable server names the URL instead of a bare 'fetch failed'", async () => {
    // The realistic case: the dev server isn't running, so `aai login` in the
    // monorepo (where isDevMode pins http://localhost:8080) got undici's bare
    // "fetch failed" — no URL, no hint, nothing to act on. `apiRequest` has
    // said "could not reach <url>" for years; login used raw fetch.
    const fetchFn = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const err = (await executeLogin(
      {},
      { fetchFn: asFetch(fetchFn), openBrowser: vi.fn(), pollIntervalMs: 1 },
    ).catch((e: unknown) => e)) as { code?: string; message?: string; hint?: string };

    expect(err.code).toBe("login_unreachable");
    expect(err.message).toContain("localhost:8080");
    expect(err.hint).toBeTruthy();
  });

  test("a server that dies mid-approval reports unreachable, not a fake timeout", async () => {
    // Reporting "timed out waiting for the link to be approved" would blame
    // the user for a server that went away.
    let call = 0;
    const fetchFn = vi.fn((input: string | URL) => {
      call++;
      if (String(input).includes("/studio/auth")) {
        return Promise.resolve(new Response(JSON.stringify({ mode: "dev" }), { status: 200 }));
      }
      return Promise.reject(new TypeError("fetch failed"));
    });
    const err = (await executeLogin(
      {},
      {
        fetchFn: asFetch(fetchFn),
        openBrowser: vi.fn(),
        pollIntervalMs: 1,
        timeoutMs: 5,
      },
    ).catch((e: unknown) => e)) as { code?: string };

    expect(err.code).toBe("login_unreachable");
    expect(call).toBeGreaterThan(1);
  });

  test("survives a brief blip while polling — a restart shouldn't lose the login", async () => {
    let exchangeCalls = 0;
    const fetchFn = vi.fn((input: string | URL) => {
      if (String(input).includes("/studio/auth")) {
        return Promise.resolve(new Response(JSON.stringify({ mode: "dev" }), { status: 200 }));
      }
      exchangeCalls++;
      if (exchangeCalls === 1) return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(
        new Response(JSON.stringify({ apiKey: "k", email: "a@b.test" }), { status: 200 }),
      );
    });
    const result = await executeLogin(
      {},
      { fetchFn: asFetch(fetchFn), openBrowser: vi.fn(), pollIntervalMs: 1 },
    );
    expect(result.ok).toBe(true);
  });

  test("fails when the exchange returns no API key", async () => {
    const { fetchFn } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "supabase" } }),
      "/studio/cli-link/exchange": () => ({ body: { ok: true } }),
    });
    await expect(
      executeLogin({}, { fetchFn, openBrowser: vi.fn(), pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ code: "login_failed" });
  });

  test("times out when the link is never approved", async () => {
    const { fetchFn } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "supabase" } }),
      "/studio/cli-link/exchange": () => ({ status: 404, body: { pending: true } }),
    });
    await expect(
      executeLogin({}, { fetchFn, openBrowser: vi.fn(), pollIntervalMs: 1, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "login_timeout" });
  });

  test("surfaces an expired approval as a login failure", async () => {
    const { fetchFn } = fakeFetch({
      "/studio/auth": () => ({ body: { mode: "supabase" } }),
      "/studio/cli-link/exchange": () => ({
        status: 410,
        body: { error: "Link approval expired — run `aai login` again" },
      }),
    });
    await expect(
      executeLogin({}, { fetchFn, openBrowser: vi.fn(), pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ code: "login_failed" });
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
