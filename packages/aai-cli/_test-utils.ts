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
