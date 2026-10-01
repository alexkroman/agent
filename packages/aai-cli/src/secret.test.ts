// Copyright 2025 the AAI authors. MIT license.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { parseEnv } from "node:util";
import { sleep } from "@alexkroman1/aai/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { PlatformDeps } from "./_slug-api.ts";
import { createFakeUi, type FakeUi, withTempDir } from "./_test-utils.ts";
import {
  executeLocalSecretDelete,
  executeLocalSecretPut,
  executeSecretDelete,
  executeSecretList,
  executeSecretPut,
  resolveSecretValue,
} from "./secret.ts";

// The platform the executors are HANDED: target resolution answers fixed
// values, and `apiRequest` returns what each spec scripts. The response GUARDS
// (`checkedResponse`, `isStringArray`) stay real — they are part of what these
// specs exercise.
const mockApiRequest = vi.fn();
const getServerInfo = vi.fn();
const platform = { getServerInfo, apiRequest: mockApiRequest } as unknown as PlatformDeps;
let ui: FakeUi;

beforeEach(() => {
  ui = createFakeUi();
  getServerInfo.mockResolvedValue({
    serverUrl: "http://localhost:9999",
    slug: "test-agent",
    apiKey: "test-api-key",
  });
});

afterEach(() => {
  // Module-level `vi.fn()`s, which `restoreMocks` does not reach: reset, or a
  // `toHaveBeenCalledWith` is satisfied by an earlier test's call.
  mockApiRequest.mockReset();
  getServerInfo.mockReset();
});

describe("executeSecretList", () => {
  test("returns list of secret names", async () => {
    mockApiRequest.mockResolvedValue({ vars: ["API_KEY", "DB_URL", "SECRET_TOKEN"] });

    const result = await executeSecretList("/tmp", undefined, ui, platform);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual(["API_KEY", "DB_URL", "SECRET_TOKEN"]);
    }
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", undefined, ui, platform);

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("returns empty list when no secrets exist", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    const result = await executeSecretList("/tmp", undefined, ui, platform);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.secrets).toEqual([]);
    }
  });

  test("passes apiKey in request options", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", undefined, ui, platform);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("executeSecretPut", () => {
  test("sends secret to server with PUT method", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    const result = await executeSecretPut(
      "/tmp",
      "MY_SECRET",
      "secret-value",
      undefined,
      ui,
      platform,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("MY_SECRET");
    }
  });

  test("sends secret name and value as JSON body", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "DB_PASS", "p@ssw0rd!", undefined, ui, platform);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual({ DB_PASS: "p@ssw0rd!" });
  });

  test("calls correct URL with slug and /secret path", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "KEY", "val", undefined, ui, platform);

    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret");
  });

  test("passes action: secret in request options", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretPut("/tmp", "KEY", "val", undefined, ui, platform);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.action).toBe("secret");
  });
});

describe("executeSecretDelete", () => {
  test("sends delete request to server", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    const result = await executeSecretDelete("/tmp", "OLD_KEY", undefined, ui, platform);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("OLD_KEY");
    }
  });

  test("uses DELETE method", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "OLD_KEY", undefined, ui, platform);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.method).toBe("DELETE");
  });

  test("includes secret name in URL path", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "MY_SECRET", undefined, ui, platform);

    const [url] = mockApiRequest.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:9999/test-agent/secret/MY_SECRET");
  });

  test("passes apiKey in request options", async () => {
    mockApiRequest.mockResolvedValue({ ok: true });

    await executeSecretDelete("/tmp", "KEY", undefined, ui, platform);

    const [, init] = mockApiRequest.mock.calls[0] ?? [];
    expect(init.apiKey).toBe("test-api-key");
  });
});

describe("secret commands with explicit server", () => {
  test("executeSecretList passes server to getServerInfo", async () => {
    mockApiRequest.mockResolvedValue({ vars: [] });

    await executeSecretList("/tmp", "https://custom-server.com", ui, platform);

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

    await expect(executeSecretList("/tmp", undefined, ui, platform)).rejects.toThrow(
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

describe("aai secret put/delete --local", () => {
  test("put writes <cwd>/.env and never calls the platform; delete removes it", async () => {
    await withTempDir(async (dir) => {
      const put = await executeLocalSecretPut(dir, "MY_SECRET", "s3cret value", ui);
      expect(put).toEqual({ ok: true, data: { name: "MY_SECRET" } });
      const text = await readFile(path.join(dir, ".env"), "utf-8");
      expect(parseEnv(text)).toMatchObject({ MY_SECRET: "s3cret value" });
      expect(mockApiRequest).not.toHaveBeenCalled();

      expect(await executeLocalSecretDelete(dir, "MY_SECRET", ui)).toEqual({
        ok: true,
        data: { name: "MY_SECRET" },
      });
      expect(parseEnv(await readFile(path.join(dir, ".env"), "utf-8"))).not.toHaveProperty(
        "MY_SECRET",
      );
    });
  });

  test("deleting a name that is not set is not_found", async () => {
    await withTempDir(async (dir) => {
      const result = await executeLocalSecretDelete(dir, "NOPE", ui);
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    });
  });
});
