// Copyright 2026 the AAI authors. MIT license.
// Describe mode is a one-shot exec whose whole contract is a single JSON
// stdout line carrying the spawner's nonce; these tests pin that envelope
// (ok/config/error/nonce and the exit code) and the nonce scrub that keeps
// bundle code from ever reading the value it would have to forge.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mainDescribe, takeDescribeNonce } from "./harness-describe.ts";

describe("takeDescribeNonce", () => {
  afterEach(() => {
    delete process.env.AAI_DESCRIBE_NONCE;
  });

  test("returns the nonce and REMOVES it from process.env before any bundle import", () => {
    process.env.AAI_DESCRIBE_NONCE = "n-123";
    expect(takeDescribeNonce()).toBe("n-123");
    expect(process.env.AAI_DESCRIBE_NONCE).toBeUndefined();
  });

  test("returns undefined when no nonce was delivered", () => {
    expect(takeDescribeNonce()).toBeUndefined();
  });
});

describe("mainDescribe", () => {
  let dir: string;
  let writes: string[];
  let exits: (number | undefined)[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harness-describe-"));
    writes = [];
    exits = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    // Recording, non-throwing: nothing follows the exit call in either path,
    // so letting it return keeps the flow identical without tearing down the
    // runner. (A throwing mock inside the success path's `try` would bounce
    // into the catch and emit a second, bogus envelope.)
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** The last non-empty stdout line parsed as JSON — the spawner's read. */
  function lastJsonLine(): Record<string, unknown> {
    const line = writes
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .at(-1);
    if (!line) throw new Error("no stdout line emitted");
    return JSON.parse(line) as Record<string, unknown>;
  }

  const BUNDLE = [
    'export default { name: "described", systemPrompt: "p" };',
    "export const __aaiCreateRuntime = () => ({ startSession() {}, shutdown: async () => {} });",
    'export const __aaiConfig = { name: "described" };',
  ].join("\n");

  test("prints the self-described config with the nonce and exits 0", async () => {
    const bundlePath = path.join(dir, "bundle.mjs");
    await writeFile(bundlePath, BUNDLE, "utf-8");

    await mainDescribe(bundlePath, "nonce-1");

    expect(lastJsonLine()).toEqual({
      ok: true,
      config: { name: "described" },
      nonce: "nonce-1",
    });
    expect(exits).toEqual([0]);
  });

  test("omits the nonce key when the spawner delivered none", async () => {
    const bundlePath = path.join(dir, "bundle.mjs");
    await writeFile(bundlePath, BUNDLE, "utf-8");

    await mainDescribe(bundlePath, undefined);

    expect(lastJsonLine()).not.toHaveProperty("nonce");
    expect(exits).toEqual([0]);
  });

  test("an unreadable bundle path reports ok:false and exits 1", async () => {
    await mainDescribe(path.join(dir, "missing.mjs"), "nonce-2");

    const line = lastJsonLine();
    expect(line.ok).toBe(false);
    expect(typeof line.error).toBe("string");
    expect(line.nonce).toBe("nonce-2");
    expect(exits).toEqual([1]);
  });

  test("a bundle without __aaiCreateRuntime fails the describe rather than answering", async () => {
    const bundlePath = path.join(dir, "bundle.mjs");
    await writeFile(bundlePath, "export default { name: 'x' };", "utf-8");

    await mainDescribe(bundlePath, undefined);

    const line = lastJsonLine();
    expect(line.ok).toBe(false);
    expect(line.error).toContain("__aaiCreateRuntime");
    expect(exits).toEqual([1]);
  });
});
