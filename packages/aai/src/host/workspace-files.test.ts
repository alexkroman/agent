// Copyright 2026 the AAI authors. MIT license.
// The rules every side that snapshots a workspace shares. This module exists
// because the CLI's push and the guest's sync write the same map from opposite
// ends, and a disagreement between them is not an error but a file silently
// dropped on one path and resurrected on the other — so the rules are pinned
// here, once, rather than inferred from either caller.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  decodeWorkspaceText,
  isLocalOnlyFile,
  isLockfile,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  snapshotWorkspaceFiles,
  walkWorkspaceFiles,
} from "./workspace-files.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aai-workspace-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write `rel` (creating parents) with `content`. */
async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

describe("isLockfile", () => {
  test.for([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
  ])("%s is a lockfile", (name) => {
    expect(isLockfile(name)).toBe(true);
  });

  test.for(["package.json", "agent.ts", "lock.json", "my-yarn.lock"])(
    "%s is not a lockfile",
    (name) => {
      expect(isLockfile(name)).toBe(false);
    },
  );
});

describe("isLocalOnlyFile", () => {
  test("covers secrets AND every lockfile — push drops the whole set", () => {
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".DS_Store",
      "package-lock.json",
      "pnpm-lock.yaml",
    ]) {
      expect.soft(isLocalOnlyFile(name), name).toBe(true);
    }
  });

  /**
   * `.env.example` is the ONE `.env*` name that is source, and the scaffold's
   * own `.gitignore` says so (`.env`, `.env.*`, then `!.env.example`): it is
   * where an author writes down which secrets the agent needs. Caught by the
   * `.env` pattern it was dropped from every push with no warning — the skip
   * rule is deliberately silent — and the next `aai pull` re-supplied the
   * scaffold's boilerplate over the top, so the author's documentation
   * round-tripped away. It is also what lets this predicate filter a template
   * COPY, where dropping the scaffold's copy leaves a project with no `.env`.
   */
  test("does not drop .env.example, which the scaffold ships as source", () => {
    expect(isLocalOnlyFile(".env.example")).toBe(false);
  });

  test("does not drop ordinary source", () => {
    for (const name of ["agent.ts", "package.json", "client.tsx", "envs.ts", ".environment"]) {
      expect.soft(isLocalOnlyFile(name), name).toBe(false);
    }
  });

  // The guest applies only the lockfile half, so the two must stay orderable:
  // everything a lockfile check catches, the push check catches too.
  test("every lockfile is also local-only", () => {
    for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
      expect.soft(isLockfile(name) && isLocalOnlyFile(name), name).toBe(true);
    }
  });
});

describe("walkWorkspaceFiles", () => {
  test("skips the ignored directories wherever they appear", async () => {
    await put("agent.ts", "x");
    await put("node_modules/date-fns/index.js", "x");
    await put("dist/worker.js", "x");
    await put(".aai/project.json", "x");
    await put(".git/HEAD", "x");
    await put("src/tools/book.ts", "x");

    expect(await walkWorkspaceFiles(dir)).toEqual([
      "agent.ts",
      path.join("src", "tools", "book.ts"),
    ]);
  });

  test("applies the caller's per-file skip", async () => {
    await put("agent.ts", "x");
    await put("package-lock.json", "{}");

    expect(await walkWorkspaceFiles(dir, { skipFile: isLockfile })).toEqual(["agent.ts"]);
  });

  test("skips symlinks — a workspace is a file map, and a link escapes it", async () => {
    await put("agent.ts", "x");
    await symlink(path.join(dir, "agent.ts"), path.join(dir, "link.ts"));

    expect(await walkWorkspaceFiles(dir)).toEqual(["agent.ts"]);
  });
});

describe("snapshotWorkspaceFiles", () => {
  test("names an oversized file rather than dropping it silently", async () => {
    await put("agent.ts", "x");
    await put("big.json", "y".repeat(MAX_WORKSPACE_FILE_BYTES + 1));

    const snap = await snapshotWorkspaceFiles(dir);

    expect(Object.keys(snap.files)).toEqual(["agent.ts"]);
    expect(snap.warnings).toHaveLength(1);
    expect(snap.warnings[0]).toContain("big.json");
  });

  test("names a non-UTF-8 file rather than corrupting it", async () => {
    await writeFile(path.join(dir, "logo.png"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    const snap = await snapshotWorkspaceFiles(dir);

    expect(snap.files).toEqual({});
    expect(snap.warnings[0]).toContain("not valid UTF-8");
  });

  test("caps the file count, naming the tree the way the caller does", async () => {
    // The subject rides only this warning — "Project" for a push, the default
    // "Workspace" for the guest's sync.
    await Promise.all(
      Array.from({ length: MAX_WORKSPACE_FILES + 5 }, (_, i) => put(`f${i}.ts`, "x")),
    );

    const snap = await snapshotWorkspaceFiles(dir, { subject: "Project" });

    expect(Object.keys(snap.files)).toHaveLength(MAX_WORKSPACE_FILES);
    expect(snap.warnings[0]).toBe(
      `Project has ${MAX_WORKSPACE_FILES + 5} files; only the first ${MAX_WORKSPACE_FILES} sync.`,
    );
  });
});

describe("decodeWorkspaceText", () => {
  test("keeps a leading BOM — the corruption check must not corrupt", () => {
    // Stripping it by default would make the guard perform a smaller version
    // of the mangling it exists to prevent.
    expect(decodeWorkspaceText(new TextEncoder().encode("﻿hi"))).toBe("﻿hi");
  });

  test("rejects invalid UTF-8 instead of substituting U+FFFD", () => {
    expect(decodeWorkspaceText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
  });
});
