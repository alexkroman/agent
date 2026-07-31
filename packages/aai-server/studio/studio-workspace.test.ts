// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { MAX_STUDIO_FILES } from "./studio-schemas.ts";
import {
  assertWorkspaceLimits,
  createWorkspace,
  currentFilesHash,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  listProjects,
  mutateWorkspace,
  type StudioWorkspace,
  studioScope,
} from "./studio-workspace.ts";
import { createMemoryWorkspaceStore, WorkspaceConflictError } from "./workspace-store.ts";

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
  test("create/get round-trips files and deployedSlug", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "scope1", "proj", {
      files: { "agent.ts": "code" },
      deployedSlug: "my-slug",
    });
    const ws = await getWorkspace(store, "scope1", "proj");
    expect(ws?.files).toEqual({ "agent.ts": "code" });
    expect(ws?.deployedSlug).toBe("my-slug");
    expect(ws?.updatedAt).toBeGreaterThan(0);
  });

  test("create stamps the files hash so reads never recompute it", async () => {
    const store = createMemoryWorkspaceStore();
    const files = { "agent.ts": "code" };
    await createWorkspace(store, "s", "p", { files });
    const ws = await getWorkspace(store, "s", "p");
    expect(ws?.hash).toBe(filesHash(files));
  });

  test("creating an existing project conflicts", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "agent.ts": "winner" } });
    await expect(createWorkspace(store, "s", "p", { files: {} })).rejects.toThrow(
      WorkspaceConflictError,
    );
    // The loser did not reset the winner's files.
    expect((await getWorkspace(store, "s", "p"))?.files).toEqual({ "agent.ts": "winner" });
  });

  test("get returns null for a missing project", async () => {
    const store = createMemoryWorkspaceStore();
    expect(await getWorkspace(store, "scope1", "nope")).toBeNull();
  });

  test("delete removes the project", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: {} });
    await deleteWorkspace(store, "s", "p");
    expect(await getWorkspace(store, "s", "p")).toBeNull();
  });

  test("listProjects returns only the scope's projects, sorted", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s1", "beta", { files: {} });
    await createWorkspace(store, "s1", "alpha", { files: {} });
    await createWorkspace(store, "s2", "other", { files: {} });
    expect(await listProjects(store, "s1")).toEqual(["alpha", "beta"]);
    expect(await listProjects(store, "s2")).toEqual(["other"]);
    expect(await listProjects(store, "s3")).toEqual([]);
  });

  test("treats non-workspace documents as missing", async () => {
    const store = createMemoryWorkspaceStore();
    await store.put("s", "scalar", 42, null);
    // `typeof null === "object"` — these used to pass the shape check and
    // blow up downstream as TypeErrors (500s) instead of a clean 404.
    await store.put("s", "null-files", { files: null, updatedAt: 1 }, null);
    await store.put("s", "array-files", { files: [], updatedAt: 1 }, null);
    await store.put("s", "array-doc", [{ files: {} }], null);
    expect(await getWorkspace(store, "s", "scalar")).toBeNull();
    expect(await getWorkspace(store, "s", "null-files")).toBeNull();
    expect(await getWorkspace(store, "s", "array-files")).toBeNull();
    expect(await getWorkspace(store, "s", "array-doc")).toBeNull();
  });

  test("rejects path traversal in file names", async () => {
    const store = createMemoryWorkspaceStore();
    await expect(
      createWorkspace(store, "s", "p", { files: { "../evil.ts": "x" } }),
    ).rejects.toThrow(/Invalid file path/);
    await expect(createWorkspace(store, "s", "p2", { files: { "/abs.ts": "x" } })).rejects.toThrow(
      /Invalid file path/,
    );
  });
});

describe("mutateWorkspace", () => {
  test("applies the mutation and stamps a fresh hash", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "agent.ts": "a" } });
    const ws = await mutateWorkspace(store, "s", "p", (current) => ({
      ...current,
      files: { ...current.files, "b.ts": "b" },
    }));
    expect(ws?.files).toEqual({ "agent.ts": "a", "b.ts": "b" });
    expect(ws?.hash).toBe(filesHash({ "agent.ts": "a", "b.ts": "b" }));
    expect((await getWorkspace(store, "s", "p"))?.files["b.ts"]).toBe("b");
  });

  test("resolves null for a missing project and never creates one", async () => {
    const store = createMemoryWorkspaceStore();
    expect(await mutateWorkspace(store, "s", "ghost", (ws) => ws)).toBeNull();
    expect(await getWorkspace(store, "s", "ghost")).toBeNull();
  });

  test("mutate returning null declines the write", async () => {
    const store = createMemoryWorkspaceStore();
    const created = await createWorkspace(store, "s", "p", { files: { "agent.ts": "a" } });
    const ws = await mutateWorkspace(store, "s", "p", () => null);
    expect(ws?.files).toEqual(created.files);
    expect((await store.get("s", "p"))?.version).toBe(1);
  });

  test("a mid-mutation delete does not resurrect the project", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "agent.ts": "a" } });
    const result = await mutateWorkspace(store, "s", "p", async (current) => {
      await deleteWorkspace(store, "s", "p");
      return current;
    });
    // The versioned put conflicts (row gone), the retry re-reads and finds
    // nothing — the delete wins.
    expect(result).toBeNull();
    expect(await getWorkspace(store, "s", "p")).toBeNull();
  });

  test("retries once when a concurrent writer bumps the version", async () => {
    // The cross-replica race: the local lock cannot serialize a writer on
    // another machine, so the versioned put conflicts and the mutation is
    // re-derived against a fresh read — both edits survive.
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "agent.ts": "a" } });
    let raced = false;
    const ws = await mutateWorkspace(store, "s", "p", async (current) => {
      if (!raced) {
        raced = true;
        await mutateWorkspace(store, "s", "p", (other) => ({
          ...other,
          files: { ...other.files, "other-replica.ts": "x" },
        }));
      }
      return { ...current, files: { ...current.files, "mine.ts": "y" } };
    });
    expect(ws?.files).toEqual({ "agent.ts": "a", "other-replica.ts": "x", "mine.ts": "y" });
  });

  test("a second consecutive conflict surfaces the error", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: {} });
    const bump = () =>
      mutateWorkspace(store, "s", "p", (ws) => ({
        ...ws,
        files: { ...ws.files, [`f${Date.now()}-${Math.random()}.ts`]: "x" },
      }));
    await expect(
      mutateWorkspace(store, "s", "p", async (current) => {
        await bump(); // every attempt loses the race
        return { ...current, files: { ...current.files, "mine.ts": "y" } };
      }),
    ).rejects.toThrow(WorkspaceConflictError);
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

describe("currentFilesHash", () => {
  test("uses the stored hash when present", () => {
    // The stored value wins even when it disagrees with the files — that is
    // the point: reads trust what the write stamped instead of recomputing.
    const ws: StudioWorkspace = { files: { "a.ts": "1" }, hash: "stored", updatedAt: 1 };
    expect(currentFilesHash(ws)).toBe("stored");
  });

  test("falls back to computing for pre-hash documents", () => {
    const files = { "a.ts": "1" };
    const ws: StudioWorkspace = { files, updatedAt: 1 };
    expect(currentFilesHash(ws)).toBe(filesHash(files));
  });
});

describe("hasUnpublishedChanges (stored hash)", () => {
  test("an old document without a stored hash still compares correctly", () => {
    const files = { "agent.ts": "a" };
    expect(
      hasUnpublishedChanges({
        files,
        updatedAt: 1,
        deployedSlug: "s",
        deployedHash: filesHash(files),
      }),
    ).toBe(false);
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
