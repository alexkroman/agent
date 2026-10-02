// Copyright 2026 the AAI authors. MIT license.

import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { bundleSourceOf, readVerifiedBundle } from "./bundle-source.ts";

const sha = (code: string) => hash("sha256", code);

describe("bundleSourceOf", () => {
  test("picks whichever shape the spawner named", () => {
    expect(bundleSourceOf("https://blob.test/w.js", undefined)).toEqual({
      url: "https://blob.test/w.js",
    });
    expect(bundleSourceOf(undefined, "/tmp/w.js")).toEqual({ path: "/tmp/w.js" });
  });

  test("neither (or empty strings) is null, and a URL wins over a path", () => {
    expect(bundleSourceOf(undefined, undefined)).toBeNull();
    expect(bundleSourceOf("", "")).toBeNull();
    expect(bundleSourceOf("https://blob.test/w.js", "/tmp/w.js")).toEqual({
      url: "https://blob.test/w.js",
    });
  });
});

describe("readVerifiedBundle", () => {
  test("reads a path and accepts it against its hash, in either case", async () => {
    const path = import.meta.filename;
    const code = readFileSync(path, "utf-8");
    await expect(readVerifiedBundle({ path }, sha(code).toUpperCase())).resolves.toBe(code);
  });

  test("fetches a URL and verifies the bytes it got", async () => {
    const code = "export default 1;";
    const url = `data:text/javascript,${encodeURIComponent(code)}`;
    await expect(readVerifiedBundle({ url }, sha(code))).resolves.toBe(code);
  });

  test("refuses bytes that do not match the named hash", async () => {
    const url = "data:text/javascript,tampered";
    await expect(readVerifiedBundle({ url }, sha("original"))).rejects.toThrow(/hash mismatch/);
  });

  test("a rejected fetch names the status and never the signed URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    const url = "https://storage.test/w.js?token=secret-signature";
    const err = await readVerifiedBundle({ url }, sha("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("HTTP 400");
    expect(String(err)).not.toContain("secret-signature");
  });

  test("a transport failure is reported as a fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("socket hang up"));
    await expect(
      readVerifiedBundle({ url: "https://storage.test/w.js" }, sha("x")),
    ).rejects.toThrow("bundle fetch failed: socket hang up");
  });
});
