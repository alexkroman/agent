// Copyright 2026 the AAI authors. MIT license.
/**
 * `_safe-write.ts` against a REAL filesystem: what `lstat` and `O_NOFOLLOW`
 * see is the whole point, so the links are made on disk. Scenario tier
 * because it writes files.
 *
 * The callers' specs (`studio.test.ts`, `_templates.test.ts`) pin the
 * commands' refusals; these pin the screen itself, case by case.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { refuseUnsafeTarget, writeFileNoFollow } from "./_safe-write.ts";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aai-safe-write-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("refuseUnsafeTarget", () => {
  test("passes a path nothing exists at yet, and one whose parents are real directories", async () => {
    await expect(refuseUnsafeTarget(root, "tools/new.ts")).resolves.toBeUndefined();
    await fs.mkdir(path.join(root, "tools"));
    await fs.writeFile(path.join(root, "tools", "old.ts"), "");
    await expect(refuseUnsafeTarget(root, "tools/old.ts")).resolves.toBeUndefined();
  });

  test("refuses a symlinked FILE, a symlinked DIRECTORY, and a DANGLING link", async () => {
    await fs.writeFile(path.join(outside, "victim.txt"), "keep");
    await fs.symlink(path.join(outside, "victim.txt"), path.join(root, "agent.ts"));
    await fs.symlink(outside, path.join(root, "tools"));
    await fs.symlink(path.join(outside, "nothing-here"), path.join(root, ".gitignore"));
    for (const rel of ["agent.ts", "tools/x.ts", ".gitignore"]) {
      await expect(refuseUnsafeTarget(root, rel)).rejects.toMatchObject({
        code: "symlink_in_path",
      });
    }
  });

  test("refuses a file where a parent directory must go, and a directory where the file must", async () => {
    await fs.writeFile(path.join(root, "a"), "");
    await fs.mkdir(path.join(root, "b"));
    await expect(refuseUnsafeTarget(root, "a/c.ts")).rejects.toMatchObject({
      code: "path_conflict",
    });
    await expect(refuseUnsafeTarget(root, "b")).rejects.toMatchObject({ code: "path_conflict" });
  });

  test("does not screen ROOT itself: a symlinked project directory is ordinary", async () => {
    const linked = path.join(path.dirname(root), "linked");
    await fs.symlink(root, linked);
    await expect(refuseUnsafeTarget(linked, "agent.ts")).resolves.toBeUndefined();
  });
});

describe("writeFileNoFollow", () => {
  test("creates parents and writes; `mode` is the create mode", async () => {
    const target = path.join(root, "deep", ".env");
    await writeFileNoFollow(target, "K=v\n", { mode: 0o600 });
    expect(await fs.readFile(target, "utf-8")).toBe("K=v\n");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  test("never follows a link at the file itself, dangling or not", async () => {
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "keep");
    await fs.symlink(victim, path.join(root, "live"));
    await fs.symlink(path.join(outside, "created"), path.join(root, "dangling"));
    await expect(writeFileNoFollow(path.join(root, "live"), "x")).rejects.toMatchObject({
      code: "ELOOP",
    });
    await expect(writeFileNoFollow(path.join(root, "dangling"), "x")).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await fs.readFile(victim, "utf-8")).toBe("keep");
    await expect(fs.access(path.join(outside, "created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("`exclusive` refuses an existing file instead of replacing it", async () => {
    const target = path.join(root, "README.md");
    await fs.writeFile(target, "mine");
    await expect(writeFileNoFollow(target, "theirs", { exclusive: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await fs.readFile(target, "utf-8")).toBe("mine");
  });
});
