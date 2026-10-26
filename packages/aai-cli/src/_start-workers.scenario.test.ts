// Copyright 2026 the AAI authors. MIT license.
/**
 * `isStartWorker` inside a REAL `cluster.fork` worker. Scenario tier because it
 * forks a process.
 *
 * The unit spec can only hand the predicate an env, and the env a real worker
 * sees is not the one `cluster.fork` was given: Node's bootstrap deletes
 * `NODE_UNIQUE_ID` before any user code runs. The predicate once required it,
 * so it was false in every worker, each took the single-process path, bound
 * the primary's port itself, and `aai start --workers` never booted.
 */

import cluster from "node:cluster";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SLOT_ENV } from "./_start-workers.ts";

test("a cluster-forked worker with a slot is a start worker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-start-worker-"));
  const workers = fileURLToPath(new URL("./_start-workers.ts", import.meta.url));
  const script = path.join(dir, "probe.mjs");
  await fs.writeFile(
    script,
    `import { isStartWorker } from ${JSON.stringify(workers)};\n` +
      "process.send({ worker: isStartWorker(), id: process.env.NODE_UNIQUE_ID ?? null }, () => process.exit(0));\n",
  );
  try {
    cluster.setupPrimary({ exec: script, silent: true });
    const worker = cluster.fork({ [SLOT_ENV]: "0" });
    const seen = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("exit", (code) => reject(new Error(`probe exited ${code} before reporting`)));
    });
    expect(seen).toEqual({ worker: true, id: null });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
