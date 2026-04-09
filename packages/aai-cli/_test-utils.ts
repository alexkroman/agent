// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DirectoryBundleOutput } from "./_bundler.ts";

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

/** List template names from a templates/ subdirectory. */
async function fakeListTemplates(
  rootDir: string,
): Promise<{ name: string; description: string }[]> {
  const dir = path.join(rootDir, "templates");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, description: "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Copy template + scaffold layer from a fake templates dir to targetDir. */
export async function fakeDownloadAndMerge(
  rootDir: string,
  template: string,
  targetDir: string,
): Promise<void> {
  const templates = await fakeListTemplates(rootDir);
  const names = templates.map((t) => t.name);
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }
  await fs.cp(path.join(rootDir, "templates", template), targetDir, {
    recursive: true,
    force: true,
  });
  await copyScaffoldNoOverwrite(path.join(rootDir, "scaffold"), targetDir);
}

async function copyScaffoldNoOverwrite(scaffoldDir: string, dest: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(scaffoldDir, { recursive: true, withFileTypes: true });
  } catch {
    return; // no scaffold dir
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = path.relative(scaffoldDir, path.join(entry.parentPath, entry.name));
    const destPath = path.join(dest, rel);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(path.join(scaffoldDir, rel), destPath, fs.constants.COPYFILE_EXCL);
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
}

/** Create a minimal DirectoryBundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<DirectoryBundleOutput>): DirectoryBundleOutput {
  return {
    worker: "export const tools = {};",
    clientFiles: {},
    agentConfig: {
      name: "test-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 16,
      toolChoice: "auto",
      builtinTools: [],
      toolSchemas: [],
    },
    ...overrides,
  };
}
