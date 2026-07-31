// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
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
function silenceSteps(): {
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

/**
 * Symlink this package's node_modules into a fixture project so the worker
 * wrapper's `@alexkroman1/aai/manifest` import (and any fixture import of
 * `zod`) resolves — a real project always has the SDK installed.
 */
export async function linkSdkNodeModules(dir: string): Promise<void> {
  await fs
    .symlink(path.resolve(import.meta.dirname, "node_modules"), path.join(dir, "node_modules"))
    .catch(() => undefined);
}

/** Write a map of relative path → content under `rootDir`, creating directories. */
export async function writeFiles(rootDir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return rootDir;
}

/** Stub of the `log` export from `_ui.ts`, for use inside `vi.mock` factories. */
export function makeMockLog() {
  return {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  };
}

/** Create a minimal DirectoryBundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<DirectoryBundleOutput>): DirectoryBundleOutput {
  return {
    worker: "export default { name: 'test-agent', tools: {} };",
    clientFiles: {},
    ...overrides,
  };
}
