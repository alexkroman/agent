// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BundleOutput } from "./_bundler.ts";
import { _internals } from "./_new.ts";

/** Create a temp directory, run `fn`, then clean up. */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_test_"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

/** Stub _internals.step to suppress output in tests. */
export function silenceSteps(): {
  restore: () => void;
} {
  const orig = _internals.step;
  _internals.step = () => {};
  return {
    restore() {
      _internals.step = orig;
    },
  };
}

/** Create a minimal BundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<BundleOutput>): BundleOutput {
  return {
    worker: "// worker",
    html: "<html>{{NAME}}{{BASE_PATH}}</html>",
    workerBytes: 9,
    ...overrides,
  };
}
