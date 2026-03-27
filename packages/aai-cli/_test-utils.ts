// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BundleOutput } from "./_bundler.ts";

/** Create a temp directory, run `fn`, then clean up. */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_test_"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Stub console.log to suppress output in tests. */
export function silenceSteps(): {
  restore: () => void;
} {
  const orig = console.log;
  console.log = () => {
    /* noop */
  };
  return {
    restore() {
      console.log = orig;
    },
  };
}

/** Run a function with console output silenced. */
export function silenced<T>(fn: (dir: string) => Promise<T>) {
  return async (dir: string) => {
    const s = silenceSteps();
    try {
      return await fn(dir);
    } finally {
      s.restore();
    }
  };
}

/** List template names from a directory (excludes _ prefixed dirs). */
export async function fakeListTemplates(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Copy template + _shared layer from a fake templates dir to targetDir. */
export async function fakeDownloadAndMerge(
  templatesDir: string,
  template: string,
  targetDir: string,
): Promise<void> {
  const names = await fakeListTemplates(templatesDir);
  if (!names.includes(template)) {
    throw new Error(`unknown template '${template}' -- available: ${names.join(", ")}`);
  }
  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });
  await copySharedNoOverwrite(path.join(templatesDir, "_shared"), targetDir);
}

async function copySharedNoOverwrite(sharedDir: string, dest: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sharedDir, { recursive: true, withFileTypes: true });
  } catch {
    return; // no _shared dir
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = path.relative(sharedDir, path.join(entry.parentPath, entry.name));
    const destPath = path.join(dest, rel);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(path.join(sharedDir, rel), destPath, fs.constants.COPYFILE_EXCL);
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
}

/** Create a minimal BundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<BundleOutput>): BundleOutput {
  return {
    worker: "// worker",
    clientFiles: { "index.html": "<html></html>" },
    clientDir: "/tmp/test-client",
    workerBytes: 9,
    ...overrides,
  };
}
