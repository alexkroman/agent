// Copyright 2026 the AAI authors. MIT license.
// The GoTrue provider read. Its load-bearing half is the fallback: an unknown
// answer offers GitHub-only, never nothing (a studio nobody can sign in to)
// and never everything (a button GoTrue refuses).

import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchCall, jsonResponse, stubFetch } from "./_test-utils.ts";
import {
  GITHUB_ONLY,
  NO_PROVIDERS,
  readSignInMethods,
  type SignInMethods,
} from "./auth-methods.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_BASE = "https://proj.supabase.co";

describe("readSignInMethods", () => {
  test("reads both methods off GoTrue's `external` map", async () => {
    stubFetch(() => jsonResponse({ external: { github: true, email: true } }));
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual({
      github: true,
      password: true,
    });
  });

  test("a backend with neither method says so rather than falling back", async () => {
    stubFetch(() => jsonResponse({ external: { github: false, email: false } }));
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual(NO_PROVIDERS);
  });

  test("email-only is password-only", async () => {
    stubFetch(() => jsonResponse({ external: { github: false, email: true } }));
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual({
      github: false,
      password: true,
    });
  });

  test("a non-boolean flag is NOT an enabled method", async () => {
    stubFetch(() => jsonResponse({ external: { github: "yes", email: 1 } }));
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual(NO_PROVIDERS);
  });

  test("asks GoTrue's settings route with the publishable key as `apikey`", async () => {
    const mock = stubFetch(() => jsonResponse({ external: {} }));
    await readSignInMethods(URL_BASE, "pk_live_123");
    const { url, init } = fetchCall(mock);
    expect(url).toBe(`${URL_BASE}/auth/v1/settings`);
    expect(init.headers).toEqual({ apikey: "pk_live_123" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ["no trailing slash", "https://proj.supabase.co/base"],
    ["a trailing slash", "https://proj.supabase.co/base/"],
  ])("keeps a path prefix with %s", async (_label, base) => {
    const mock = stubFetch(() => jsonResponse({ external: {} }));
    await readSignInMethods(base, "pk");
    expect(fetchCall(mock).url).toBe("https://proj.supabase.co/base/auth/v1/settings");
  });

  test.each([
    ["a non-2xx answer", () => jsonResponse({ external: { email: true } }, 500)],
    ["a body with no `external`", () => jsonResponse({ disable_signup: false })],
    ["a non-JSON body", () => new Response("<html>proxy</html>", { status: 200 })],
  ])("%s falls back to GitHub-only", async (_label, make) => {
    stubFetch(make);
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual(GITHUB_ONLY);
  });

  test("a rejected fetch falls back to GitHub-only", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(readSignInMethods(URL_BASE, "pk")).resolves.toEqual(GITHUB_ONLY);
  });

  test("an unparsable project URL falls back to GitHub-only rather than throwing", async () => {
    const mock = stubFetch(() => jsonResponse({ external: { email: true } }));
    await expect(readSignInMethods("not a url", "pk")).resolves.toEqual(GITHUB_ONLY);
    expect(mock).not.toHaveBeenCalled();
  });
});

// The same read as the sign-in screen depends on it, against GoTrue's settings
// route by PATHNAME (moved from the sign-in screen's suite).
const PASSWORD_ONLY: SignInMethods = { github: false, password: true };
const BOTH: SignInMethods = { github: true, password: true };

describe("readSignInMethods, as the sign-in screen reads it", () => {
  // `stubFetch` routes by PATHNAME, which is also the thing worth pinning here:
  // the endpoint is GoTrue's own, resolved against the project URL.
  const SETTINGS = "/auth/v1/settings";
  const PROJECT = "http://127.0.0.1:54321";

  test("reads the providers GoTrue reports", async () => {
    const fetchMock = stubFetch({
      [SETTINGS]: () => jsonResponse({ external: { github: true, email: true, google: false } }),
    });
    await expect(readSignInMethods(PROJECT, "sb_publishable_x")).resolves.toEqual(BOTH);
    // The publishable key is the whole credential for this public read.
    expect(fetchCall(fetchMock).init.headers).toMatchObject({ apikey: "sb_publishable_x" });
  });

  test("a provider absent from the payload is OFF", async () => {
    // Read strictly rather than coerced: GoTrue omits nothing today, and a
    // truthiness check would turn a future `"github": "maybe"` into a button.
    stubFetch({ [SETTINGS]: () => jsonResponse({ external: { email: true } }) });
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(PASSWORD_ONLY);
  });

  test("a trailing slash on the project URL resolves to the same endpoint", async () => {
    // The URL comes from the server's own `/studio/auth` payload, so both
    // spellings reach here and neither may produce `/auth/v1/settings` off a
    // truncated origin.
    const fetchMock = stubFetch({
      [SETTINGS]: () => jsonResponse({ external: { github: true } }),
    });
    await expect(readSignInMethods(`${PROJECT}/`, "k")).resolves.toEqual(GITHUB_ONLY);
    expect(fetchCall(fetchMock).url).toBe(`${PROJECT}${SETTINGS}`);
  });

  test.each([
    ["a non-2xx answer", () => jsonResponse({ msg: "nope" }, 500)],
    ["an unparsable body", () => new Response("<html>", { status: 200 })],
    ["a payload with no providers", () => jsonResponse({})],
  ])("%s falls back to GitHub-only, never to nothing", async (_label, route) => {
    // An UNKNOWN answer must not remove the method production actually uses —
    // that would turn one flaky read into a studio nobody can sign in to.
    stubFetch({ [SETTINGS]: route });
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(GITHUB_ONLY);
  });

  test("a rejected fetch falls back the same way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(GITHUB_ONLY);
  });
});
