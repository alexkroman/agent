// Copyright 2025 the AAI authors. MIT license.
import { gunzipSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import { type DeployOpts, runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test-utils.ts";

function deployOk(slug = "cool-cats-jump"): Response {
  return new Response(JSON.stringify({ ok: true, slug }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Shape of the (decoded) deploy request body, for test assertions. */
type DecodedDeployBody = {
  slug?: string;
  env?: Record<string, string>;
  worker?: string;
  clientFiles?: Record<string, string>;
};

/** Inflate + parse the gzipped JSON body the CLI sends. */
function decodeBody(init: RequestInit | undefined): DecodedDeployBody {
  const body = init?.body;
  if (!(body instanceof Uint8Array)) {
    throw new Error(`expected gzipped binary body, got ${typeof body}`);
  }
  return JSON.parse(gunzipSync(body).toString("utf8"));
}

/** Build a DeployOpts object with a mock fetch. */
function deployOpts(fetch: typeof globalThis.fetch, overrides?: Partial<DeployOpts>): DeployOpts {
  return {
    url: "http://localhost:3000",
    bundle: makeBundle(),
    env: {},
    slug: "cool-cats-jump",
    apiKey: "test-key",
    // No real sleeps between mock-fetch retries.
    retryDelay: 0,
    fetch,
    ...overrides,
  };
}

/**
 * Budget for the one test here whose cost is a cold cross-package TRANSFORM
 * rather than the work it asserts.
 *
 * It dynamic-imports a module from another package, which vitest has to load
 * and type-strip on the spot. That fits the 5s unit budget comfortably when
 * this file runs alone and does not under `pnpm check`, where turbo runs every
 * package's suite at once — measured failing there and passing standalone in
 * the same working tree, so it is contention, not a regression.
 *
 * The budget is raised rather than the import removed: importing the REAL
 * server schema is the entire point of the test, and a local copy of it would
 * be a second declaration of the very thing it exists to catch drift against.
 */
const CROSS_PACKAGE_IMPORT_TIMEOUT_MS = 20_000;

describe("runDeploy", () => {
  test("sends POST /deploy with auth and JSON content type", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    const result = await runDeploy(deployOpts(mockFetch));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://localhost:3000/deploy");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(result.slug).toBe("cool-cats-jump");
  });

  test("sends a gzip-compressed body with Content-Encoding header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("content-encoding")).toBe("gzip");
    // Raw bytes, not a re-JSON-encoded string — and actually gzip
    // (magic bytes 0x1f 0x8b) that inflates back to the JSON payload.
    const body = init?.body;
    expect(body).toBeInstanceOf(Uint8Array);
    const bytes = body as Uint8Array;
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(decodeBody(init).worker).toContain("test-agent");
  });

  // The parenthetical used to read "the server extracts it", which stopped
  // being true when the platform stopped storing agent config at all (see
  // "The platform stores no agent config" in packages/aai-server/CLAUDE.md).
  // The assertion is unchanged and still right; only the reason a reader uses
  // to judge a failure was wrong.
  test("sends worker and clientFiles in body (no agentConfig — the platform stores none)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.worker).toBeTruthy();
    expect(body.clientFiles).toEqual({});
    expect(body).not.toHaveProperty("agentConfig");
  });

  test("sends bundle clientFiles verbatim", async () => {
    const bundle = makeBundle({
      clientFiles: { "index.html": "<html></html>", "app.js": "console.log('hi')" },
    });
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch, { bundle }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.clientFiles).toEqual({
      "index.html": "<html></html>",
      "app.js": "console.log('hi')",
    });
  });

  test("sends env vars in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch, { env: { MY_KEY: "secret" } }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.env).toEqual({ MY_KEY: "secret" });
  });

  test("sends slug in body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk("my-slug"));
    await runDeploy(deployOpts(mockFetch, { slug: "my-slug" }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.slug).toBe("my-slug");
  });

  test("omits slug from body when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk("server-generated"));
    const { slug: _slug, ...optsWithoutSlug } = deployOpts(mockFetch);
    const result = await runDeploy(optsWithoutSlug);
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.slug).toBeUndefined();
    expect(result.slug).toBe("server-generated");
  });

  // A 200 whose body carries no `slug` used to flow on: the command printed
  // `Deployed https://server/undefined` and wrote `slug: undefined` into
  // `.aai/project.json`, which `JSON.stringify` DROPS — so the next deploy saw
  // no slug, minted a fresh one, and orphaned the running agent. Refusing the
  // response is what keeps the config honest. See `checkedResponse`.
  test.each([
    ["no slug", { ok: true }],
    ["a non-string slug", { slug: 42 }],
    ["an HTML page", "<!doctype html><title>Login</title>"],
  ])("a 200 with %s is refused instead of writing an undefined slug", async (_label, body) => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      /Unexpected response from the deploy route at http:\/\/localhost:3000/,
    );
  });

  test("throws on non-ok error response after retries", async () => {
    // 5xx is retried, so each attempt needs a fresh (unconsumed) Response.
    const mockFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("server error", { status: 500 })));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 500)");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("does not retry a slug-less first deploy (server mints a slug per request)", async () => {
    // A retried lost-response would create a second, orphaned agent.
    const mockFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("server error", { status: 500 })));
    const { slug: _slug, ...optsWithoutSlug } = deployOpts(mockFetch);
    await expect(runDeploy(optsWithoutSlug)).rejects.toThrow("deploy failed (HTTP 500)");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("throws on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      "could not reach http://localhost:3000",
    );
  });

  test("includes status code and body in error message", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("bad request: missing worker", { status: 400 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      "deploy failed (HTTP 400): bad request: missing worker",
    );
  });

  test("401 throws with API key hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("API key may be invalid");
  });

  test("413 throws with bundle size hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("too large", { status: 413 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("bundle is too large");
  });

  test(
    "deploy body conforms to server DeployBodySchema",
    async () => {
      // Import the real server schema to validate CLI deploy payload.
      // This cross-package import catches format mismatches between CLI and server.
      const { DeployBodySchema } = await import("../../aai-server/src/schemas.ts");
      const mockFetch = vi.fn().mockResolvedValue(deployOk());
      await runDeploy(deployOpts(mockFetch));
      const [, init] = mockFetch.mock.calls[0] ?? [];
      const body = decodeBody(init);
      const result = DeployBodySchema.safeParse(body);
      expect(
        result.success,
        `Deploy body rejected by server schema: ${JSON.stringify(result.error?.issues, null, 2)}`,
      ).toBe(true);
    },
    CROSS_PACKAGE_IMPORT_TIMEOUT_MS,
  );
});
