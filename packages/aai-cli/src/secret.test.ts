// Copyright 2025 the AAI authors. MIT license.

import { PassThrough } from "node:stream";
import { sleep } from "@alexkroman1/aai/internal";
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
vi.mock("./_ui.ts", async () => ({
  log: (await import("./_test-utils.ts")).makeMockLog(),
}));

// Mock apiRequest to return controlled parsed responses.
const mockApiRequest = vi.fn();
// Only `apiRequest` is faked. The response GUARDS (`checkedResponse`,
// `isStringArray`) stay real — they are part of what these specs exercise, and
// a factory that omitted them would make every guarded call site undefined.
vi.mock("./_api-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_api-client.ts")>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  HINT_NOT_DEPLOYED: "not-deployed-hint",
}));

const { executeSecretList, executeSecretPut, executeSecretDelete, resolveSecretValue } =
  await import("./secret.ts");

afterEach(() => {
  // `mockApiRequest` needs its implementation dropped too, so `mockReset`
  // rather than `mockClear`. Everything else here (the `_agent.ts` and `_ui.ts`
  // module mocks) only needs its HISTORY cleared — and it does need it:
  // `restoreMocks: true` registers only `vi.spyOn` mocks, so an
  // `expect(getServerInfo).toHaveBeenCalledWith(…)` would otherwise be
  // satisfied by any earlier test in this file that resolved a server.
  vi.clearAllMocks();
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

describe("a response that is not the secret route's", () => {
  // It used to die on `Cannot read properties of undefined (reading 'length')`
  // — a stack trace where the CLI's own sentence belongs. See
  // `checkedResponse` in `_api-client.ts`.
  test.each([
    ["a body with no `vars`", { ok: true }],
    ["a `vars` that is not an array", { vars: "MY_KEY" }],
    ["a `vars` holding non-strings", { vars: [1, 2] }],
  ])("%s is refused with a sentence naming the route", async (_label, body) => {
    mockApiRequest.mockResolvedValue(body);

    await expect(executeSecretList("/tmp", undefined)).rejects.toThrow(
      /Unexpected response from the secret list for test-agent/,
    );
  });
});

/**
 * Where a `secret put` value comes from.
 *
 * The command read stdin whenever the OUTPUT mode was json — and that mode is
 * decided by stdout — so with stdin a terminal (or an idle inherited pipe) it
 * waited for an EOF nobody was going to send: zero output, blocked forever,
 * on the only documented way to get a credential into production. Every case
 * below has to terminate, and the two that cannot produce a value have to say
 * which forms do.
 *
 * Driven through a `PassThrough` standing in for `process.stdin`, so these
 * exercise the real reader — the wait itself is the thing that was broken.
 */
describe("resolveSecretValue", () => {
  test("reads a piped value when stdin is not a terminal", async () => {
    const stdin = new PassThrough();
    const value = resolveSecretValue("FOO", "json", { stdin, stdinIsTTY: false });
    stdin.end("s3cret\n");
    await expect(value).resolves.toBe("s3cret");
  });

  test("an open pipe that never writes gives up instead of blocking", async () => {
    // The reproduction: `sleep 25 | aai secret put FOO`. The stream stays
    // open, so a read-to-EOF waits forever; only the first-byte deadline ends
    // it. Left OPEN deliberately — ending it would test the case below.
    await expect(
      resolveSecretValue("FOO", "json", {
        stdin: new PassThrough(),
        stdinIsTTY: false,
        firstByteMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "no_input",
      message: expect.stringContaining("nothing arrived on stdin"),
      hint: expect.stringContaining("aai secret put FOO"),
    });
  });

  test("an empty stdin says so instead, and is not sent to the server", async () => {
    const stdin = new PassThrough();
    const value = resolveSecretValue("FOO", "json", { stdin, stdinIsTTY: false });
    stdin.end();
    await expect(value).rejects.toMatchObject({
      code: "no_input",
      message: expect.stringContaining("stdin was empty"),
    });
  });

  test("a slow producer is NOT cut off once its first byte has landed", async () => {
    const stdin = new PassThrough();
    const value = resolveSecretValue("FOO", "json", { stdin, stdinIsTTY: false, firstByteMs: 20 });
    stdin.write("s3");
    // Past the first-byte deadline, which bounds only the first chunk.
    await sleep(60);
    stdin.end("cret");
    await expect(value).resolves.toBe("s3cret");
  });

  test("a terminal stdin in JSON mode is refused AT ONCE rather than read", async () => {
    // The other half of the hang: JSON mode is auto-detected on a pipe, so
    // this is `aai secret put FOO | tee log` with a human at the keyboard.
    // An open stream that never writes would block if it were read at all.
    await expect(
      resolveSecretValue("FOO", "json", { stdin: new PassThrough(), stdinIsTTY: true }),
    ).rejects.toMatchObject({
      code: "no_input",
      message: expect.stringContaining("--json cannot prompt"),
    });
  });

  test("a terminal stdin in human mode defers to the prompt", async () => {
    await expect(
      resolveSecretValue("FOO", "human", { stdin: new PassThrough(), stdinIsTTY: true }),
    ).resolves.toBeUndefined();
  });
});
