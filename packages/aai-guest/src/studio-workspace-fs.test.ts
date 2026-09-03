// Copyright 2026 the AAI authors. MIT license.
// The guest's end of the workspace round trip. The rules themselves live in
// the SDK (workspace-files.test.ts); what is pinned here is the one place this
// side deliberately differs from `aai push`.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { useTempDir } from "./_test-utils.ts";
import {
  materializeWorkspace,
  resolveInside,
  snapshotWorkspace,
  walkWorkspace,
} from "./studio-workspace-fs.ts";

const dir = useTempDir("aai-guest-ws-");

const put = async (rel: string, content: string): Promise<void> => {
  const abs = path.join(dir(), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
};

describe("snapshotWorkspace", () => {
  test("drops lockfiles — a resolved tree is not source", async () => {
    // `add_dependency` runs `npm install`, which reifies the whole manifest,
    // so the lockfile it leaves is ~100 KB after three ordinary dependencies
    // and would be the bulk of every turn's sync and of what `aai pull` writes.
    await put("agent.ts", "x");
    await put("package.json", "{}");
    await put("package-lock.json", "{}");
    await put("pnpm-lock.yaml", "lockfileVersion: 9");

    expect(Object.keys(await snapshotWorkspace(dir()).then((s) => s.files))).toEqual([
      "agent.ts",
      "package.json",
    ]);
  });

  test("keeps a .env the coding agent wrote — push's other rule is NOT applied here", async () => {
    await put(".env", "KEY=1");
    const snap = await snapshotWorkspace(dir());
    expect(snap.files[".env"]).toBe("KEY=1");
  });
});

describe("walkWorkspace", () => {
  test("still shows the lockfile — this backs list_files/grep, not the sync", async () => {
    // Hiding it from the tools would make a file the agent can legitimately
    // inspect invisible; only the SYNC has a reason to drop it.
    await put("package-lock.json", "{}");
    expect(await walkWorkspace(dir())).toEqual(["package-lock.json"]);
  });
});

describe("materializeWorkspace", () => {
  test("replaces whatever was there, including an installed node_modules", async () => {
    // This `rm -rf` is why a workspace's declared dependencies have to be
    // reinstalled on every session install (see studio-workspace-deps.ts).
    await put("node_modules/date-fns/package.json", "{}");
    await put("stale.ts", "x");

    await materializeWorkspace(dir(), { "agent.ts": "fresh" });

    expect(await walkWorkspace(dir())).toEqual(["agent.ts"]);
  });

  test("creates parent directories for nested files", async () => {
    await materializeWorkspace(dir(), { "tools/book.ts": "x" });
    expect(await walkWorkspace(dir())).toEqual([path.join("tools", "book.ts")]);
  });
});

describe("resolveInside", () => {
  test("refuses a path that escapes the workspace", () => {
    expect(() => resolveInside(dir(), "../secrets")).toThrow(/escapes the workspace/);
  });

  test("allows a nested path", () => {
    expect(resolveInside(dir(), "tools/book.ts")).toBe(path.join(dir(), "tools", "book.ts"));
  });

  test("does not care how the ROOT is spelled", () => {
    // The shipped symptom of the open-coded containment check this now shares
    // with `aai-runtime`: `resolveInside("/a/b/", "c.ts")` THREW "Path escapes
    // the workspace" for a path plainly inside the workspace, because
    // `"/a/b/c.ts".startsWith("/a/b/" + "/")` is false. Every root in the guest
    // today is `path.join`ed, so it fails closed and no caller is broken — this
    // is the next caller's test. Same for a `.` segment and a relative root.
    const base = dir();
    const want = path.join(base, "c.ts");
    for (const root of [
      base,
      `${base}${path.sep}`,
      path.join(base, "."),
      `${base}${path.sep}${path.sep}`,
    ]) {
      expect(resolveInside(root, "c.ts"), `root=${root}`).toBe(want);
    }
  });

  test("refuses an escape however the root is spelled", () => {
    // The other direction: normalizing the root must not have widened it.
    const base = dir();
    for (const root of [base, `${base}${path.sep}`, path.join(base, ".")]) {
      expect(() => resolveInside(root, "../secrets"), `root=${root}`).toThrow(
        /escapes the workspace/,
      );
      expect(() => resolveInside(root, "sub/../../secrets"), `root=${root}`).toThrow(
        /escapes the workspace/,
      );
    }
  });

  test("names the path it refused, not the path it computed", () => {
    // The message is this module's and stays this module's — the CLI's copy of
    // the same predicate reports a different sentence, which is why only the
    // PREDICATE is shared.
    expect(() => resolveInside(dir(), "../secrets")).toThrow(
      "Path escapes the workspace: ../secrets",
    );
  });
});
