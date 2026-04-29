// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DirectoryBundleOutput } from "./_bundler.ts";

export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_test_"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

export function silenceSteps(): () => void {
  const orig = console.log;
  console.log = () => {
    /* noop */
  };
  return () => {
    console.log = orig;
  };
}

export function silenced<T>(fn: (dir: string) => Promise<T>): (dir: string) => Promise<T> {
  return async (dir) => {
    const restore = silenceSteps();
    try {
      return await fn(dir);
    } finally {
      restore();
    }
  };
}

export async function fakeDownloadAndMerge(
  rootDir: string,
  template: string,
  targetDir: string,
): Promise<void> {
  const templatesDir = path.join(rootDir, "templates");
  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }
  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });
  await copyScaffoldNoOverwrite(path.join(rootDir, "scaffold"), targetDir);
}

async function copyScaffoldNoOverwrite(scaffoldDir: string, dest: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(scaffoldDir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const srcPath = path.join(entry.parentPath, entry.name);
    const destPath = path.join(dest, path.relative(scaffoldDir, srcPath));
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
}

/** Create a minimal DirectoryBundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<DirectoryBundleOutput>): DirectoryBundleOutput {
  return {
    worker: "export default { name: 'test-agent', tools: {} };",
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
