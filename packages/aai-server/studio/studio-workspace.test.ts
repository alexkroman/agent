// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createTestStorage } from "../test-utils.ts";
import { MAX_STUDIO_FILES } from "./studio-schemas.ts";
import {
  assertWorkspaceLimits,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  listProjects,
  putWorkspace,
  type StudioWorkspace,
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

describe("hasUnpublishedChanges", () => {
  const at = (over: Partial<StudioWorkspace> = {}): StudioWorkspace => ({
    files: { "agent.ts": "a" },
    updatedAt: 1,
    ...over,
  });

  test("a never-published project is not 'stale'", () => {
    // The preview says "nothing published yet"; a stale banner on top of that
    // would be noise.
    expect(hasUnpublishedChanges(at())).toBe(false);
  });

  test("published and untouched is up to date", () => {
    const files = { "agent.ts": "a" };
    expect(
      hasUnpublishedChanges(at({ files, deployedSlug: "s", deployedHash: filesHash(files) })),
    ).toBe(false);
  });

  test("an edit since the last publish is unpublished", () => {
    expect(
      hasUnpublishedChanges(
        at({
          files: { "agent.ts": "b" },
          deployedSlug: "s",
          deployedHash: filesHash({ "agent.ts": "a" }),
        }),
      ),
    ).toBe(true);
  });

  test("editing and undoing is not a change", () => {
    // A timestamp would call this stale forever; a content hash does not.
    const files = { "agent.ts": "a" };
    const published = filesHash(files);
    expect(
      hasUnpublishedChanges(
        at({ files: { ...files }, deployedSlug: "s", deployedHash: published }),
      ),
    ).toBe(false);
  });

  test("adding or deleting a file counts", () => {
    const published = filesHash({ "agent.ts": "a" });
    expect(
      hasUnpublishedChanges(
        at({
          files: { "agent.ts": "a", "shared.ts": "x" },
          deployedSlug: "s",
          deployedHash: published,
        }),
      ),
    ).toBe(true);
    expect(
      hasUnpublishedChanges(at({ files: {}, deployedSlug: "s", deployedHash: published })),
    ).toBe(true);
  });
});

describe("filesHash", () => {
  test("does not depend on key order", () => {
    expect(filesHash({ a: "1", b: "2" })).toBe(filesHash({ b: "2", a: "1" }));
  });

  test("changes when content changes", () => {
    expect(filesHash({ a: "1" })).not.toBe(filesHash({ a: "2" }));
  });
});
