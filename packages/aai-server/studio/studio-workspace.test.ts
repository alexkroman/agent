// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createTestStorage } from "../test-utils.ts";
import { MAX_STUDIO_FILES } from "./studio-schemas.ts";
import {
  assertWorkspaceLimits,
  deleteWorkspace,
  getWorkspace,
  listProjects,
  putWorkspace,
  studioScope,
} from "./studio-workspace.ts";

describe("studioScope", () => {
  test("is deterministic per key and distinct across keys", () => {
    expect(studioScope("key-a")).toBe(studioScope("key-a"));
    expect(studioScope("key-a")).not.toBe(studioScope("key-b"));
  });

  test("produces a storage-safe token", () => {
    expect(studioScope("key/with:odd chars")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("workspace CRUD", () => {
  test("put/get round-trips files and deployedSlug", async () => {
    const storage = createTestStorage();
    await putWorkspace(storage, "scope1", "proj", {
      files: { "agent.ts": "code" },
      deployedSlug: "my-slug",
    });
    const ws = await getWorkspace(storage, "scope1", "proj");
    expect(ws?.files).toEqual({ "agent.ts": "code" });
    expect(ws?.deployedSlug).toBe("my-slug");
    expect(ws?.updatedAt).toBeGreaterThan(0);
  });

  test("get returns null for a missing project", async () => {
    const storage = createTestStorage();
    expect(await getWorkspace(storage, "scope1", "nope")).toBeNull();
  });

  test("delete removes the project", async () => {
    const storage = createTestStorage();
    await putWorkspace(storage, "s", "p", { files: {} });
    await deleteWorkspace(storage, "s", "p");
    expect(await getWorkspace(storage, "s", "p")).toBeNull();
  });

  test("listProjects returns only the scope's projects, sorted", async () => {
    const storage = createTestStorage();
    await putWorkspace(storage, "s1", "beta", { files: {} });
    await putWorkspace(storage, "s1", "alpha", { files: {} });
    await putWorkspace(storage, "s2", "other", { files: {} });
    expect(await listProjects(storage, "s1")).toEqual(["alpha", "beta"]);
    expect(await listProjects(storage, "s2")).toEqual(["other"]);
    expect(await listProjects(storage, "s3")).toEqual([]);
  });

  test("treats corrupted or non-workspace documents as missing", async () => {
    const storage = createTestStorage();
    await storage.setItem("studio/s/corrupt", "{not json");
    await storage.setItem("studio/s/scalar", "42");
    expect(await getWorkspace(storage, "s", "corrupt")).toBeNull();
    expect(await getWorkspace(storage, "s", "scalar")).toBeNull();
  });

  test("rejects path traversal in file names", async () => {
    const storage = createTestStorage();
    await expect(putWorkspace(storage, "s", "p", { files: { "../evil.ts": "x" } })).rejects.toThrow(
      /Invalid file path/,
    );
    await expect(putWorkspace(storage, "s", "p", { files: { "/abs.ts": "x" } })).rejects.toThrow(
      /Invalid file path/,
    );
  });
});

describe("assertWorkspaceLimits", () => {
  test("rejects too many files", () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_STUDIO_FILES + 1 }, (_, i) => [`f${i}.ts`, ""]),
    );
    expect(() => assertWorkspaceLimits(files)).toThrow(/Too many files/);
  });

  test("rejects an oversized file", () => {
    expect(() => assertWorkspaceLimits({ "big.ts": "x".repeat(300_000) })).toThrow(
      /File too large/,
    );
  });

  test("rejects an oversized workspace total", () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, "x".repeat(250_000)]),
    );
    expect(() => assertWorkspaceLimits(files)).toThrow(/Workspace too large/);
  });

  test("accepts a normal workspace", () => {
    expect(() => assertWorkspaceLimits({ "agent.ts": "export default {}" })).not.toThrow();
  });
});
