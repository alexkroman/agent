// Copyright 2026 the AAI authors. MIT license.

import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { createWorkspace, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";
import { createWorkspaceSession } from "./studio-workspace-session.ts";

const SCOPE = "s";
const PROJECT = "p";

async function seeded(files: Record<string, string> = { "agent.ts": "code" }) {
  const store = createMemoryWorkspaceStore();
  await createWorkspace(store, SCOPE, PROJECT, { files });
  return { store, session: createWorkspaceSession(store, SCOPE, PROJECT) };
}

describe("createWorkspaceSession", () => {
  test("reads the workspace from the store exactly once per session", async () => {
    const { store, session } = await seeded();
    const get = vi.spyOn(store, "get");
    expect((await session.current())?.files).toEqual({ "agent.ts": "code" });
    await session.current();
    await session.current();
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("current() is null for a missing project", async () => {
    const store = createMemoryWorkspaceStore();
    const session = createWorkspaceSession(store, SCOPE, "ghost");
    expect(await session.current()).toBeNull();
  });

  test("update writes through to the store and refreshes the snapshot", async () => {
    const { store, session } = await seeded();
    const message = await session.update((files) => {
      files["new.ts"] = "export {};";
      return "wrote";
    });
    expect(message).toBe("wrote");
    // Write-through: the store sees the edit immediately (browser freshness).
    const stored = await getWorkspace(store, SCOPE, PROJECT);
    expect(stored?.files["new.ts"]).toBe("export {};");
    // Snapshot refreshed without another store read.
    const get = vi.spyOn(store, "get");
    expect((await session.current())?.files["new.ts"]).toBe("export {};");
    expect(get).not.toHaveBeenCalled();
  });

  test("update errors for a missing project", async () => {
    const store = createMemoryWorkspaceStore();
    const session = createWorkspaceSession(store, SCOPE, "ghost");
    expect(await session.update(() => "never")).toMatch(/not found/);
  });

  test("a rejected write leaves the snapshot and store untouched", async () => {
    const { store, session } = await seeded();
    // Workspace limits still apply on writes: a traversal path is rejected by
    // the write path, comes back as an error string, and nothing sticks.
    const out = await session.update((files) => {
      files["../evil.ts"] = "x";
      return "never";
    });
    expect(out).toMatch(/^Error: Invalid file path/);
    expect((await session.current())?.files).toEqual({ "agent.ts": "code" });
    expect((await getWorkspace(store, SCOPE, PROJECT))?.files).toEqual({ "agent.ts": "code" });
  });

  test("update surfaces edit-callback failures as error strings", async () => {
    const { session } = await seeded();
    expect(
      await session.update(() => {
        throw new Error("boom");
      }),
    ).toBe("Error: boom");
  });

  test("sequential updates each see the previous write", async () => {
    const { session } = await seeded();
    await session.update((files) => {
      files["a.ts"] = "1";
      return "ok";
    });
    const out = await session.update((files) => ("a.ts" in files ? "saw it" : "lost it"));
    expect(out).toBe("saw it");
  });

  test("a write racing another replica retries and both edits survive", async () => {
    // The in-process lock can't see a writer on another replica; the
    // versioned put conflicts and the edit is re-applied to a fresh read.
    const { store, session } = await seeded();
    let raced = false;
    const message = await session.update(async (files) => {
      if (!raced) {
        raced = true;
        await mutateWorkspace(store, SCOPE, PROJECT, (ws) => ({
          ...ws,
          files: { ...ws.files, "replica.ts": "other" },
        }));
      }
      files["mine.ts"] = "y";
      return "wrote";
    });
    expect(message).toBe("wrote");
    const stored = await getWorkspace(store, SCOPE, PROJECT);
    expect(stored?.files).toEqual({ "agent.ts": "code", "replica.ts": "other", "mine.ts": "y" });
  });
});
