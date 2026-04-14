// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";

// Mock _agent.ts so getServerInfo returns test values without requiring
// a real project config or API key prompt.
vi.mock("./_agent.ts", () => ({
  getServerInfo: vi.fn().mockResolvedValue({
    serverUrl: "http://localhost:9999",
    slug: "test-agent",
    apiKey: "test-api-key",
  }),
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

// Mock _ui.ts to silence log output in tests.
vi.mock("./_ui.ts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

// Mock apiRequestOrThrow to return controlled responses.
const mockApiRequestOrThrow = vi.fn();
vi.mock("./_api-client.ts", () => ({
  apiRequestOrThrow: (...args: unknown[]) => mockApiRequestOrThrow(...args),
}));

const { executeSecretList, executeSecretPut, executeSecretDelete } = await import("./secret.ts");

afterEach(() => {
  mockApiRequestOrThrow.mockReset();
});

describe("executeSecretList", () => {
  test("returns list of secret names", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ vars: ["API_KEY", "DB_URL", "SECRET_TOKEN"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await executeSecretList("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual(["API_KEY", "DB_URL", "SECRET_TOKEN"]);
    }
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ vars: [] }), { status: 200 }),
    );

    await executeSecretList("/tmp", undefined);

    expect(mockApiRequestOrThrow).toHaveBeenCalledTimes(1);
    const [url] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("returns empty list when no secrets exist", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ vars: [] }), { status: 200 }),
    );

    const result = await executeSecretList("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual([]);
    }
  });

  test("passes apiKey in request options", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ vars: [] }), { status: 200 }),
    );

    await executeSecretList("/tmp", undefined);

    const [, init] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("executeSecretPut", () => {
  test("sends secret to server with PUT method", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await executeSecretPut("/tmp", "MY_SECRET", "secret-value", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("MY_SECRET");
    }
  });

  test("sends secret name and value as JSON body", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretPut("/tmp", "DB_PASS", "p@ssw0rd!", undefined);

    const [, init] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ DB_PASS: "p@ssw0rd!" });
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretPut("/tmp", "KEY", "val", undefined);

    const [url] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("passes action: secret in request options", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretPut("/tmp", "KEY", "val", undefined);

    const [, init] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(init.action).toBe("secret");
  });
});

describe("executeSecretDelete", () => {
  test("sends delete request to server", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await executeSecretDelete("/tmp", "OLD_KEY", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("OLD_KEY");
    }
  });

  test("uses DELETE method", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretDelete("/tmp", "OLD_KEY", undefined);

    const [, init] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(init.method).toBe("DELETE");
  });

  test("includes secret name in URL path", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretDelete("/tmp", "MY_SECRET", undefined);

    const [url] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret/MY_SECRET");
  });

  test("passes apiKey in request options", async () => {
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeSecretDelete("/tmp", "KEY", undefined);

    const [, init] = mockApiRequestOrThrow.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("secret commands with explicit server", () => {
  test("executeSecretList passes server to getServerInfo", async () => {
    const { getServerInfo } = await import("./_agent.ts");
    mockApiRequestOrThrow.mockResolvedValue(
      new Response(JSON.stringify({ vars: [] }), { status: 200 }),
    );

    await executeSecretList("/tmp", "https://custom-server.com");

    expect(getServerInfo).toHaveBeenCalledWith("/tmp", "https://custom-server.com");
  });
});
