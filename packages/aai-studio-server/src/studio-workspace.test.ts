// Copyright 2025 the AAI authors. MIT license.

import {
  createMemoryWorkspaceStore,
  WorkspaceConflictError,
  type WorkspaceStore,
} from "aai-server/stores";
import { describe, expect, test } from "vitest";
import {
  MAX_STUDIO_FILE_BYTES,
  MAX_STUDIO_FILES,
  MAX_STUDIO_WORKSPACE_BYTES,
} from "./studio-schemas.ts";
import {
  assertWorkspaceLimits,
  createWorkspace,
  deleteWorkspace,
  filesHash,
  getWorkspace,
  hasUnpublishedChanges,
  listProjects,
  mutateWorkspace,
  type StudioWorkspace,
  stampWorkspaceMeta,
  studioScope,
  syncWorkspaceSource,
} from "./studio-workspace.ts";

describe("syncWorkspaceSource (aai push)", () => {
  const files = { "agent.ts": "v1" };

  test("upserts: creates a missing project, then replaces files", async () => {
    const store = createMemoryWorkspaceStore();
    const created = await syncWorkspaceSource(store, "s", "p", files);
    expect(created.created).toBe(true);
    expect(created.sourceHash).toBe(filesHash(files));
    const next = await syncWorkspaceSource(store, "s", "p", { "agent.ts": "v2" });
    expect(next.created).toBe(false);
    expect(next.changed).toBe(true);
    expect((await getWorkspace(store, "s", "p"))?.files).toEqual({ "agent.ts": "v2" });
  });

  test("preserves deploy/preview metadata across a files replacement", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", {
      files,
      deployedSlug: "p",
      deployedHash: filesHash(files),
      previewSlug: "p-preview",
      previewError: "boom",
    });
    const { workspace } = await syncWorkspaceSource(store, "s", "p", { "agent.ts": "v2" });
    expect(workspace.deployedSlug).toBe("p");
    expect(workspace.previewSlug).toBe("p-preview");
    expect(workspace.previewError).toBe("boom");
    // The stamped hash tracks the NEW files, so unpublished flips true.
    expect(hasUnpublishedChanges(workspace)).toBe(true);
  });

  test("fast-forward: a stale baseHash conflicts instead of stomping", async () => {
    const store = createMemoryWorkspaceStore();
    const { sourceHash } = await syncWorkspaceSource(store, "s", "p", files);
    // Someone else (a chat turn, an editor save) moved the files.
    await syncWorkspaceSource(store, "s", "p", { "agent.ts": "theirs" });
    await expect(
      syncWorkspaceSource(store, "s", "p", { "agent.ts": "mine" }, sourceHash),
    ).rejects.toThrow(WorkspaceConflictError);
    // The interloper's edit survived.
    expect((await getWorkspace(store, "s", "p"))?.files).toEqual({ "agent.ts": "theirs" });
  });

  test("metadata stamps do NOT stale the token — only file moves do", async () => {
    const store = createMemoryWorkspaceStore();
    const { sourceHash } = await syncWorkspaceSource(store, "s", "p", files);
    // A preview deploy stamping metadata bumps the row version but not the
    // files — the whole reason the token is the files hash.
    await mutateWorkspace(store, "s", "p", (current) => ({
      ...current,
      previewSlug: "p-preview",
      previewHash: sourceHash,
    }));
    const pushed = await syncWorkspaceSource(store, "s", "p", { "agent.ts": "v2" }, sourceHash);
    expect(pushed.changed).toBe(true);
  });

  test("identical files are a no-op: same hash, no write", async () => {
    const store = createMemoryWorkspaceStore();
    const { sourceHash } = await syncWorkspaceSource(store, "s", "p", files);
    const before = (await store.get("s", "p"))?.version;
    const again = await syncWorkspaceSource(store, "s", "p", { ...files }, sourceHash);
    expect(again.changed).toBe(false);
    expect(again.sourceHash).toBe(sourceHash);
    expect((await store.get("s", "p"))?.version).toBe(before);
  });

  test("a baseHash against a deleted project conflicts rather than recreating", async () => {
    const store = createMemoryWorkspaceStore();
    const { sourceHash } = await syncWorkspaceSource(store, "s", "p", files);
    await deleteWorkspace(store, "s", "p");
    await expect(syncWorkspaceSource(store, "s", "p", files, sourceHash)).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect(await getWorkspace(store, "s", "p")).toBeNull();
  });

  test("enforces the same path/limit validation as every other writer", async () => {
    const store = createMemoryWorkspaceStore();
    await expect(syncWorkspaceSource(store, "s", "p", { "../evil.ts": "x" })).rejects.toThrow(
      /Invalid file path/,
    );
  });
});

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

  /**
   * A path is NORMALIZED where it is stored, not merely validated on the way
   * past. `./agent.ts` and `agent.ts` are the same file and both pass the
   * safe-path check, and the map used to be keyed on whatever the writer sent
   * — two entries denoting one file, both listed in the editor, with whichever
   * the bundler resolved being the one that ran.
   */
  test("normalizes file paths, so one file is never two keys", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "./agent.ts": "code" } });
    expect((await getWorkspace(store, "s", "p"))?.files).toEqual({ "agent.ts": "code" });

    // Both spellings in ONE write: they always denoted one file, and the later
    // entry is what a plain object literal would have kept.
    await mutateWorkspace(store, "s", "p", (current) => ({
      ...current,
      files: { "agent.ts": "first", "./agent.ts": "second" },
    }));
    expect((await getWorkspace(store, "s", "p"))?.files).toEqual({ "agent.ts": "second" });
  });

  test("a push spelling a path differently is not a change", async () => {
    // The hash is of the NORMALIZED map, so `aai push` sending `./agent.ts`
    // for a stored `agent.ts` is byte-identical: no version bump, no preview
    // churn — on every push, not just the first.
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: { "agent.ts": "code" } });
    const result = await syncWorkspaceSource(store, "s", "p", { "./agent.ts": "code" });
    expect(result.changed).toBe(false);
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

  // Simulates a writer on ANOTHER replica, so it must bypass this process's
  // workspace lock (which mutateWorkspace holds while the callback runs —
  // a nested mutateWorkspace on the same project would deadlock, exactly
  // like a real same-project write from inside a mutate callback).
  const foreignWrite = async (store: WorkspaceStore, file: string) => {
    const record = await store.get("s", "p");
    if (!record) throw new Error("missing row");
    const doc = record.doc as { files: Record<string, string> };
    await store.put("s", "p", { ...doc, files: { ...doc.files, [file]: "x" } }, record.version);
  };

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
        await foreignWrite(store, "other-replica.ts");
      }
      return { ...current, files: { ...current.files, "mine.ts": "y" } };
    });
    expect(ws?.files).toEqual({ "agent.ts": "a", "other-replica.ts": "x", "mine.ts": "y" });
  });

  test("a second consecutive conflict surfaces the error", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: {} });
    let n = 0;
    await expect(
      mutateWorkspace(store, "s", "p", async (current) => {
        await foreignWrite(store, `f${n++}.ts`); // every attempt loses the race
        return { ...current, files: { ...current.files, "mine.ts": "y" } };
      }),
    ).rejects.toThrow(WorkspaceConflictError);
  });

  test("serializes concurrent local mutations on the same project", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: {} });
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = mutateWorkspace(store, "s", "p", async (current) => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
      return { ...current, files: { ...current.files, "a.ts": "a" } };
    });
    const second = mutateWorkspace(store, "s", "p", async (current) => {
      order.push("second");
      return { ...current, files: { ...current.files, "b.ts": "b" } };
    });
    gate.resolve();
    const [, ws] = await Promise.all([first, second]);
    // Second waited for first, so neither burned the conflict retry.
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(ws?.files).toEqual({ "a.ts": "a", "b.ts": "b" });
  });

  test("different projects do not block each other", async () => {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "s", "p", { files: {} });
    await createWorkspace(store, "s", "p2", { files: {} });
    const gate = Promise.withResolvers<void>();
    const held = mutateWorkspace(store, "s", "p", async (current) => {
      await gate.promise;
      return current;
    });
    // Completes while p's lock is still held.
    await expect(mutateWorkspace(store, "s", "p2", (current) => current)).resolves.not.toBeNull();
    gate.resolve();
    await held;
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

  test("total-size cap is a backstop the file-count and per-file caps already imply", () => {
    // Every workspace that passes the count and per-file checks fits under the
    // total cap, so the total-size throw is unreachable today — it only bites
    // if one of the other caps is raised without revisiting this one.
    expect(MAX_STUDIO_FILES * MAX_STUDIO_FILE_BYTES).toBeLessThanOrEqual(
      MAX_STUDIO_WORKSPACE_BYTES,
    );
  });

  test("accepts a normal workspace", () => {
    expect(() => assertWorkspaceLimits({ "agent.ts": "export default {}" })).not.toThrow();
  });
});

describe("hasUnpublishedChanges", () => {
  // `hash` is stamped from the RESULTING files, the way `stampWorkspace` does —
  // deriving it from the base would leave an override's hash describing the
  // wrong tree, which is the one thing these assertions read.
  const at = (over: Partial<StudioWorkspace> = {}): StudioWorkspace => {
    const base: StudioWorkspace = { files: { "agent.ts": "a" }, hash: "", updatedAt: 1, ...over };
    return { ...base, hash: over.hash ?? filesHash(base.files) };
  };

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

/**
 * Metadata stamps — the writes that dominate a project's life. Every settled
 * edit is followed by a preview deploy stamping `previewSlug`/`previewHash`;
 * Publish stamps the deploy pair; the database switch stamps
 * `databaseEnabled`. None of them touches the file map, and each used to
 * read and rewrite the whole document anyway.
 */
describe("stampWorkspaceMeta", () => {
  const files = { "agent.ts": "v1" };

  async function seeded(): Promise<WorkspaceStore> {
    const store = createMemoryWorkspaceStore();
    await createWorkspace(store, "scope", "proj", { files });
    return store;
  }

  test("records metadata and leaves the files and their hash alone", async () => {
    const store = await seeded();
    const before = await getWorkspace(store, "scope", "proj");
    const stamped = await stampWorkspaceMeta(store, "scope", "proj", {
      deployedSlug: "proj-x7k2",
      deployedHash: filesHash(files),
    });
    expect(stamped?.files).toEqual(files);
    // `hash` is the files' hash, so a stamp that disturbed it would make a
    // published project read as unpublished for ever after.
    expect(stamped?.hash).toBe(before?.hash);
    expect(hasUnpublishedChanges(stamped as StudioWorkspace)).toBe(false);
  });

  test("an undefined field REMOVES it — the shape the call sites had", async () => {
    const store = await seeded();
    await stampWorkspaceMeta(store, "scope", "proj", {
      previewHash: "h",
      previewError: "boom",
    });
    const cleared = await stampWorkspaceMeta(store, "scope", "proj", {
      previewSlug: "proj-preview",
      previewError: undefined,
    });
    expect(cleared).toMatchObject({ previewSlug: "proj-preview", previewHash: "h" });
    // Absent, not `undefined`-valued: `previewError` present at all is what
    // the Preview pane renders its failure banner from.
    expect(cleared && "previewError" in cleared).toBe(false);
  });

  test("cannot revert a file edit that lands mid-deploy", async () => {
    // The reason a stamp is a patch rather than a read-modify-write. A
    // Publish takes seconds; an agent turn syncing files inside that window
    // used to be protected only by the versioned put NOTICING and retrying.
    const store = await seeded();
    const stale = await getWorkspace(store, "scope", "proj");
    await syncWorkspaceSource(store, "scope", "proj", { "agent.ts": "v2" });

    // Stamped from the pre-deploy snapshot, exactly as studio-deploy.ts does.
    const stamped = await stampWorkspaceMeta(store, "scope", "proj", {
      deployedSlug: "proj-x7k2",
      deployedHash: (stale as StudioWorkspace).hash,
    });

    expect(stamped?.files).toEqual({ "agent.ts": "v2" });
    // And the mid-deploy edit correctly reads as unpublished: what shipped
    // was the older snapshot.
    expect(hasUnpublishedChanges(stamped as StudioWorkspace)).toBe(true);
  });

  test("a deleted project is not resurrected to record a slug", async () => {
    const store = await seeded();
    await deleteWorkspace(store, "scope", "proj");
    expect(await stampWorkspaceMeta(store, "scope", "proj", { deployedSlug: "x" })).toBeNull();
    expect(await getWorkspace(store, "scope", "proj")).toBeNull();
  });
});
