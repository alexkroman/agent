// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createTestStorage } from "../test-utils.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";
import { createWorkspaceSession } from "./studio-workspace-session.ts";

const SCOPE = "s";
const PROJECT = "p";

async function seeded(files: Record<string, string> = { "agent.ts": "code" }) {
  const storage = createTestStorage();
  await putWorkspace(storage, SCOPE, PROJECT, { files });
  return { storage, session: createWorkspaceSession(storage, SCOPE, PROJECT) };
}

describe("createWorkspaceSession", () => {
  test("reads the workspace from storage exactly once per session", async () => {
    const { storage, session } = await seeded();
    const getItem = vi.spyOn(storage, "getItem");
    expect((await session.current())?.files).toEqual({ "agent.ts": "code" });
    await session.current();
    await session.current();
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  test("current() is null for a missing project", async () => {
    const storage = createTestStorage();
    const session = createWorkspaceSession(storage, SCOPE, "ghost");
    expect(await session.current()).toBeNull();
  });

  test("update writes through to storage and refreshes the snapshot", async () => {
    const { storage, session } = await seeded();
    const message = await session.update((files) => {
      files["new.ts"] = "export {};";
      return "wrote";
    });
    expect(message).toBe("wrote");
    // Write-through: storage sees the edit immediately (browser freshness).
    const stored = await getWorkspace(storage, SCOPE, PROJECT);
    expect(stored?.files["new.ts"]).toBe("export {};");
    // Snapshot refreshed without another storage read.
    const getItem = vi.spyOn(storage, "getItem");
    expect((await session.current())?.files["new.ts"]).toBe("export {};");
    expect(getItem).not.toHaveBeenCalled();
  });

  test("update errors for a missing project", async () => {
    const storage = createTestStorage();
    const session = createWorkspaceSession(storage, SCOPE, "ghost");
    expect(await session.update(() => "never")).toMatch(/not found/);
  });

  test("a rejected write leaves the snapshot and storage untouched", async () => {
    const { storage, session } = await seeded();
    // Workspace limits still apply on writes: a traversal path is rejected by
    // putWorkspace, comes back as an error string, and nothing sticks.
    const out = await session.update((files) => {
      files["../evil.ts"] = "x";
      return "never";
    });
    expect(out).toMatch(/^Error: Invalid file path/);
    expect((await session.current())?.files).toEqual({ "agent.ts": "code" });
    expect((await getWorkspace(storage, SCOPE, PROJECT))?.files).toEqual({ "agent.ts": "code" });
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
});
