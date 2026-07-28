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
  agentConfig: Record<string, unknown>;
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
    fetch,
    ...overrides,
  };
}

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
    expect(decodeBody(init).agentConfig.name).toBe("test-agent");
  });

  test("sends worker, clientFiles, and agentConfig in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.worker).toBeTruthy();
    expect(body.clientFiles).toEqual({});
    expect(body.agentConfig.name).toBe("test-agent");
    expect(body.agentConfig.toolSchemas).toEqual([]);
  });

  test("sends bundle clientFiles and agentConfig fields verbatim", async () => {
    const bundle = makeBundle({
      clientFiles: { "index.html": "<html></html>", "app.js": "console.log('hi')" },
      agentConfig: {
        name: "custom-agent",
        systemPrompt: "You are helpful",
        greeting: "Hello!",
        maxSteps: 10,
        toolChoice: "required",
        builtinTools: ["run_code"],
        toolSchemas: [{ name: "search", description: "Search", parameters: {} }],
      },
    });
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch, { bundle }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    expect(body.clientFiles).toEqual({
      "index.html": "<html></html>",
      "app.js": "console.log('hi')",
    });
    expect(body.agentConfig.name).toBe("custom-agent");
    expect(body.agentConfig.greeting).toBe("Hello!");
    expect(body.agentConfig.maxSteps).toBe(10);
    expect(body.agentConfig.builtinTools).toEqual(["run_code"]);
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

  test("throws on non-ok error response after retries", async () => {
    // 5xx is retried, so each attempt needs a fresh (unconsumed) Response.
    const mockFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("server error", { status: 500 })));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 500)");
    expect(mockFetch).toHaveBeenCalledTimes(3);
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

  test("deploy body conforms to server DeployBodySchema", async () => {
    // Import the real server schema to validate CLI deploy payload.
    // This cross-package import catches format mismatches between CLI and server.
    const { DeployBodySchema } = await import("../aai-server/schemas.ts");
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = decodeBody(init);
    const result = DeployBodySchema.safeParse(body);
    expect(
      result.success,
      `Deploy body rejected by server schema: ${JSON.stringify(result.error?.issues, null, 2)}`,
    ).toBe(true);
  });
});
