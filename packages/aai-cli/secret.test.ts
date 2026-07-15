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

// Mock apiRequest to return controlled parsed responses.
const mockApiRequest = vi.fn();
vi.mock("./_api-client.ts", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const { executeSecretList, executeSecretPut, executeSecretDelete } = await import("./secret.ts");

afterEach(() => {
  mockApiRequest.mockReset();
});

describe("executeSecretList", () => {
  test("returns list of secret names", async () => {
    mockApiRequest.mockResolvedValue({ vars: ["API_KEY", "DB_URL", "SECRET_TOKEN"] });

    const result = await executeSecretList("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual(["API_KEY", "DB_URL", "SECRET_TOKEN"]);
    }
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", undefined);

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("returns empty list when no secrets exist", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    const result = await executeSecretList("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual([]);
    }
  });

  test("passes apiKey in request options", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("executeSecretPut", () => {
  test("sends secret to server with PUT method", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    const result = await executeSecretPut("/tmp", "MY_SECRET", "secret-value", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("MY_SECRET");
    }
  });

  test("sends secret name and value as JSON body", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "DB_PASS", "p@ssw0rd!", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual({ DB_PASS: "p@ssw0rd!" });
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "KEY", "val", undefined);

    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("passes action: secret in request options", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "KEY", "val", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.action).toBe("secret");
  });
});

describe("executeSecretDelete", () => {
  test("sends delete request to server", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    const result = await executeSecretDelete("/tmp", "OLD_KEY", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("OLD_KEY");
    }
  });

  test("uses DELETE method", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "OLD_KEY", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.method).toBe("DELETE");
  });

  test("includes secret name in URL path", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "MY_SECRET", undefined);

    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret/MY_SECRET");
  });

  test("passes apiKey in request options", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "KEY", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("secret commands with explicit server", () => {
  test("executeSecretList passes server to getServerInfo", async () => {
    const { getServerInfo } = await import("./_agent.ts");
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", "https://custom-server.com");

    expect(getServerInfo).toHaveBeenCalledWith("/tmp", "https://custom-server.com");
  });
});
