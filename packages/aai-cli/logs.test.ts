// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./_agent.ts", () => ({
  getServerInfo: vi.fn().mockResolvedValue({
    serverUrl: "http://localhost:9999",
    slug: "test-agent",
    apiKey: "test-api-key",
  }),
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  message: vi.fn(),
}));
vi.mock("./_ui.ts", () => ({ log: mockLog }));

const mockApiRequest = vi.fn();
// Only `apiRequest` is faked; `checkedResponse` stays real, because rejecting a
// body that is not a log page is part of what these specs exercise.
vi.mock("./_api-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_api-client.ts")>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const { executeLogs, formatLine } = await import("./logs.ts");

function line(seq: number, text: string, stream: "stdout" | "stderr" = "stdout") {
  return { seq, at: Date.UTC(2026, 0, 1), stream, text };
}

function page(over: Record<string, unknown> = {}) {
  return { lines: [], cursor: -1, dropped: 0, running: true, ...over };
}

/** Every line the command wrote, in order. */
const written = () => mockLog.message.mock.calls.map(([m]) => String(m));

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeLogs", () => {
  test("reads from the oldest line held and prints what came back", async () => {
    mockApiRequest.mockResolvedValue(page({ lines: [line(0, "hello"), line(1, "world")] }));

    const result = await executeLogs("/tmp/proj");

    expect(result).toMatchObject({ ok: true, data: { slug: "test-agent", lines: 2 } });
    expect(written().join("\n")).toContain("hello");
    expect(written().join("\n")).toContain("world");
    expect(String(mockApiRequest.mock.calls[0]?.[0])).toBe(
      "http://localhost:9999/test-agent/logs?after=-1",
    );
  });

  test("an agent that is up but quiet reads differently from one that is not", async () => {
    mockApiRequest.mockResolvedValue(page({ running: true }));
    await executeLogs("/tmp/proj");
    expect(mockLog.info.mock.calls.flat().join("\n")).toContain("printed nothing yet");

    vi.clearAllMocks();
    mockApiRequest.mockResolvedValue(page({ running: false }));
    await executeLogs("/tmp/proj");
    expect(mockLog.info.mock.calls.flat().join("\n")).toContain("isn't running");
  });

  test("says out loud that the ring is not durable", async () => {
    mockApiRequest.mockResolvedValue(page({ lines: [line(0, "x")] }));
    await executeLogs("/tmp/proj");
    expect(mockLog.info.mock.calls.flat().join("\n")).toContain("Recent output only");
  });

  test("reports a gap rather than swallowing it", async () => {
    mockApiRequest.mockResolvedValue(page({ lines: [line(9, "after")], dropped: 3 }));
    await executeLogs("/tmp/proj");
    expect(mockLog.warn.mock.calls.flat().join("\n")).toContain("3 earlier line(s) dropped");
  });

  test("refuses a body that is not a log page", async () => {
    mockApiRequest.mockResolvedValue({ nope: true });
    await expect(executeLogs("/tmp/proj")).rejects.toThrow(/logs route/);
  });

  describe("--follow", () => {
    test("passes the previous page's cursor back and keeps appending", async () => {
      const controller = new AbortController();
      mockApiRequest
        .mockResolvedValueOnce(page({ lines: [line(0, "first")], cursor: 0 }))
        .mockResolvedValueOnce(page({ lines: [line(1, "second")], cursor: 1 }))
        .mockImplementation(() => {
          controller.abort();
          return Promise.resolve(page({ cursor: 1 }));
        });

      const result = await executeLogs("/tmp/proj", {
        follow: true,
        pollMs: 1,
        signal: controller.signal,
      });

      expect(written().join("\n")).toContain("second");
      expect(result).toMatchObject({ ok: true, data: { lines: 2 } });
      expect(String(mockApiRequest.mock.calls[1]?.[0])).toContain("after=0");
    });

    test("a failed poll does not end the follow", async () => {
      const controller = new AbortController();
      mockApiRequest
        .mockResolvedValueOnce(page())
        .mockRejectedValueOnce(new Error("network down"))
        .mockImplementation(() => {
          controller.abort();
          return Promise.resolve(page({ lines: [line(0, "recovered")], cursor: 0 }));
        });

      await executeLogs("/tmp/proj", { follow: true, pollMs: 1, signal: controller.signal });

      expect(written().join("\n")).toContain("recovered");
    });

    test("an already-aborted signal reads once and stops", async () => {
      mockApiRequest.mockResolvedValue(page({ lines: [line(0, "only")] }));

      await executeLogs("/tmp/proj", {
        follow: true,
        pollMs: 1,
        signal: AbortSignal.abort(),
      });

      expect(mockApiRequest).toHaveBeenCalledTimes(1);
    });
  });
});

describe("formatLine", () => {
  test("marks stderr and leaves stdout unadorned", () => {
    expect(formatLine(line(0, "out"))).not.toContain("ERR");
    expect(formatLine(line(1, "boom", "stderr"))).toContain("ERR");
  });

  test("leads with a millisecond-resolution timestamp", () => {
    expect(formatLine(line(0, "x"))).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} /);
  });
});
