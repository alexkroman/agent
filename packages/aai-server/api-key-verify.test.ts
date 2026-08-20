// Copyright 2026 the AAI authors. MIT license.
// The platform's only ABSOLUTE authentication check (api-key-verify.ts).
// Every property here is one that, written the other way, leaves the verifier
// looking like it works while accepting keys AssemblyAI never issued.

import { describe, expect, test, vi } from "vitest";
import {
  createApiKeyVerifierFromEnv,
  createAssemblyAiKeyVerifier,
  DEFAULT_KEY_VERIFY_URL,
} from "./api-key-verify.ts";
import { captureLogs } from "./test-utils.ts";

/**
 * A fetch double answering one status for every call, counting calls.
 *
 * Typed with the real parameters rather than `async () => …`: a zero-arg
 * double gives `mock.calls` an empty tuple type, so the assertions that read
 * back the url and headers stop compiling.
 */
function fakeFetch(status: number) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(status === 200 ? "{}" : "", { status }),
  );
}

describe("createAssemblyAiKeyVerifier", () => {
  test("a 2xx is valid and a 401/403 is invalid", async () => {
    await expect(createAssemblyAiKeyVerifier({ fetchFn: fakeFetch(200) })("k")).resolves.toBe(true);
    await expect(createAssemblyAiKeyVerifier({ fetchFn: fakeFetch(401) })("k")).resolves.toBe(
      false,
    );
    await expect(createAssemblyAiKeyVerifier({ fetchFn: fakeFetch(403) })("k")).resolves.toBe(
      false,
    );
  });

  // The one that matters most: an unreachable or broken upstream must not
  // read as a pass, or the hole reopens for the duration of any outage an
  // attacker can provoke or simply wait for.
  test.each([500, 502, 429, 404])("HTTP %i throws rather than resolving valid", async (status) => {
    const verify = createAssemblyAiKeyVerifier({ fetchFn: fakeFetch(status) });
    await expect(verify("k")).rejects.toThrow(/verification failed/);
  });

  test("a network failure throws rather than resolving valid", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const verify = createAssemblyAiKeyVerifier({ fetchFn });
    await expect(verify("k")).rejects.toThrow(/ENOTFOUND/);
  });

  test("sends the bare key as Authorization — no Bearer prefix", async () => {
    const fetchFn = fakeFetch(200);
    await createAssemblyAiKeyVerifier({ fetchFn })("secret-key");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(DEFAULT_KEY_VERIFY_URL);
    expect(init?.headers).toEqual({ Authorization: "secret-key" });
  });

  test("both verdicts are cached — a rejected key does not re-ask per request", async () => {
    const good = fakeFetch(200);
    const verifyGood = createAssemblyAiKeyVerifier({ fetchFn: good });
    await verifyGood("k");
    await verifyGood("k");
    expect(good).toHaveBeenCalledTimes(1);

    // Negatives especially: without this, one unauthenticated request is one
    // upstream request, i.e. a traffic amplifier pointed at AssemblyAI.
    const bad = fakeFetch(401);
    const verifyBad = createAssemblyAiKeyVerifier({ fetchFn: bad });
    await verifyBad("k");
    await verifyBad("k");
    expect(bad).toHaveBeenCalledTimes(1);
  });

  test("distinct keys are cached independently", async () => {
    const fetchFn = fakeFetch(200);
    const verify = createAssemblyAiKeyVerifier({ fetchFn });
    await verify("a");
    await verify("b");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("a throwing verdict is NOT cached — the next call retries", async () => {
    let status = 500;
    const fetchFn = vi.fn(async () => new Response("", { status }));
    const verify = createAssemblyAiKeyVerifier({ fetchFn });
    await expect(verify("k")).rejects.toThrow();
    status = 200;
    await expect(verify("k")).resolves.toBe(true);
  });

  test("concurrent checks for one key share a single upstream call", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const fetchFn = vi.fn(() => promise);
    const verify = createAssemblyAiKeyVerifier({ fetchFn });
    const all = Promise.all([verify("k"), verify("k"), verify("k")]);
    resolve(new Response("{}", { status: 200 }));
    expect(await all).toEqual([true, true, true]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("honors a configured url", async () => {
    const fetchFn = fakeFetch(200);
    await createAssemblyAiKeyVerifier({ url: "https://example.test/check", fetchFn })("k");
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://example.test/check");
  });
});

describe("createApiKeyVerifierFromEnv", () => {
  const logs = captureLogs();

  test("production gets a verifier — a forgotten variable is not a hole", () => {
    expect(createApiKeyVerifierFromEnv({}, { localDev: false })).toBeTypeOf("function");
  });

  test("local dev gets none, so tests and `pnpm dev` keep any bearer working", () => {
    expect(createApiKeyVerifierFromEnv({}, { localDev: true })).toBeUndefined();
  });

  test("the opt-out is explicit and loud", () => {
    expect(
      createApiKeyVerifierFromEnv({ AAI_VERIFY_API_KEYS: "0" }, { localDev: false }),
    ).toBeUndefined();
    expect(logs.warns()).toContainEqual(expect.stringContaining("NOT verified"));
  });

  // `test.each`, not a `for…of` over the cases: the reporter names the value
  // that failed — which matters most for the two that look like an opt-out and
  // are not (`"false"`, and `"0 "` with its trailing space).
  test.each(["", "1", "false", "no", "0 "])(
    "AAI_VERIFY_API_KEYS=%o does not disable verification — only the exact `0` does",
    (value) => {
      expect(
        createApiKeyVerifierFromEnv({ AAI_VERIFY_API_KEYS: value }, { localDev: false }),
      ).toBeTypeOf("function");
    },
  );
});
