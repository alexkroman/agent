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

// Mock _ui.ts to silence log output in tests (keep a handle for assertions).
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  message: vi.fn(),
}));
vi.mock("./_ui.ts", () => ({ log: mockLog }));

// Mock the interactive confirmation prompt.
const mockConfirm = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (v: unknown) => typeof v === "symbol",
}));

// Mock apiRequest to return controlled parsed responses.
const mockApiRequest = vi.fn();
vi.mock("./_api-client.ts", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  HINT_NOT_DEPLOYED: "not-deployed-hint",
}));

const { executeStorageStatus, executeStorageEnable, executeStorageDisable } = await import(
  "./storage.ts"
);

afterEach(() => {
  mockApiRequest.mockReset();
  mockConfirm.mockReset();
  for (const fn of Object.values(mockLog)) fn.mockReset();
});

describe("executeStorageStatus", () => {
  test("returns enabled state from the server", async () => {
    mockApiRequest.mockResolvedValue({ enabled: true });

    const result = await executeStorageStatus("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ slug: "test-agent", enabled: true });
    }
  });

  test("returns disabled state from the server", async () => {
    mockApiRequest.mockResolvedValue({ enabled: false });

    const result = await executeStorageStatus("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(false);
    }
  });

  test("calls correct URL with slug and /storage path via GET", async () => {
    mockApiRequest.mockResolvedValue({ enabled: false });

    await executeStorageStatus("/tmp", undefined);

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    const [url, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/storage");
    expect(init.method).toBeUndefined();
  });

  test("passes apiKey and action in request options", async () => {
    mockApiRequest.mockResolvedValue({ enabled: false });

    await executeStorageStatus("/tmp", undefined);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
    expect(init.action).toBe("storage");
  });

  test("surfaces API errors", async () => {
    mockApiRequest.mockRejectedValue(new Error("storage failed (HTTP 404): not found"));

    await expect(executeStorageStatus("/tmp", undefined)).rejects.toThrow("HTTP 404");
  });
});

describe("executeStorageEnable", () => {
  test("sends POST to the storage endpoint", async () => {
    mockApiRequest.mockResolvedValue({ ok: true, enabled: true });

    const result = await executeStorageEnable("/tmp", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ slug: "test-agent", enabled: true });
    }

    const [url, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/storage");
    expect(init.method).toBe("POST");
  });

  test("mentions ctx.db.query on success", async () => {
    mockApiRequest.mockResolvedValue({ ok: true, enabled: true });

    await executeStorageEnable("/tmp", undefined);

    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("ctx.db.query(sql, params)"));
  });

  test("surfaces API errors", async () => {
    mockApiRequest.mockRejectedValue(new Error("storage failed (HTTP 500): boom"));

    await expect(executeStorageEnable("/tmp", undefined)).rejects.toThrow("HTTP 500");
  });
});

describe("executeStorageDisable", () => {
  test("with --force sends DELETE without prompting", async () => {
    mockApiRequest.mockResolvedValue({ ok: true, enabled: false });

    const result = await executeStorageDisable("/tmp", { force: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ slug: "test-agent", enabled: false });
    }

    expect(mockConfirm).not.toHaveBeenCalled();
    const [url, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/storage");
    expect(init.method).toBe("DELETE");
  });

  test("on a TTY proceeds after confirmation", async () => {
    mockConfirm.mockResolvedValue(true);
    mockApiRequest.mockResolvedValue({ ok: true, enabled: false });

    const result = await executeStorageDisable("/tmp", { isTTY: true });
    expect(result.ok).toBe(true);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
  });

  test("on a TTY declining the confirmation makes no request", async () => {
    mockConfirm.mockResolvedValue(false);

    const result = await executeStorageDisable("/tmp", { isTTY: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
    }
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  test("on a TTY a cancelled prompt (ctrl-c) makes no request", async () => {
    mockConfirm.mockResolvedValue(Symbol("clack cancel"));

    const result = await executeStorageDisable("/tmp", { isTTY: true });
    expect(result.ok).toBe(false);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  test("without a TTY refuses unless --force is passed", async () => {
    const result = await executeStorageDisable("/tmp", { isTTY: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("confirmation_required");
      expect(result.hint).toContain("--force");
    }
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  test("without a TTY --force proceeds", async () => {
    mockApiRequest.mockResolvedValue({ ok: true, enabled: false });

    const result = await executeStorageDisable("/tmp", { isTTY: false, force: true });
    expect(result.ok).toBe(true);
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
  });

  test("surfaces API errors", async () => {
    mockApiRequest.mockRejectedValue(new Error("storage failed (HTTP 403): forbidden"));

    await expect(executeStorageDisable("/tmp", { force: true })).rejects.toThrow("HTTP 403");
  });
});

describe("storage commands with explicit server", () => {
  test("executeStorageStatus passes server to getServerInfo", async () => {
    const { getServerInfo } = await import("./_agent.ts");
    mockApiRequest.mockResolvedValue({ enabled: true });

    await executeStorageStatus("/tmp", "https://custom-server.com");

    expect(getServerInfo).toHaveBeenCalledWith("/tmp", "https://custom-server.com");
  });

  test("executeStorageDisable passes server to getServerInfo", async () => {
    const { getServerInfo } = await import("./_agent.ts");
    mockApiRequest.mockResolvedValue({ ok: true, enabled: false });

    await executeStorageDisable("/tmp", { server: "https://custom-server.com", force: true });

    expect(getServerInfo).toHaveBeenCalledWith("/tmp", "https://custom-server.com");
  });
});
