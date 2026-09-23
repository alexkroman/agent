// Copyright 2026 the AAI authors. MIT license.
// The GoTrue provider read. Its load-bearing half is the fallback: an unknown
// answer offers GitHub-only, never nothing (a studio nobody can sign in to)
// and never everything (a button GoTrue refuses).

import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchCall, jsonResponse, stubFetch } from "./_test-utils.ts";
import { GITHUB_ONLY, NO_PROVIDERS, readSignInMethods } from "./auth-methods.ts";

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
