// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { runEvalWorker } from "./eval-worker.ts";

const opts = { timeoutMs: 5000, label: "probe", timeoutMessage: "probe timed out" };

describe("runEvalWorker", () => {
  test("resolves with the first message the body posts, from workerData", async () => {
    const body = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.postMessage(workerData.n * 2);
`;
    expect(await runEvalWorker<number>(body, { n: 21 }, opts)).toBe(42);
  });

  test("terminates a body that never yields, and the thread stays usable", async () => {
    await expect(
      runEvalWorker("while (true) {}", null, { ...opts, timeoutMs: 200 }),
    ).rejects.toThrow("probe timed out");
    const echo = `require("node:worker_threads").parentPort.postMessage("alive");`;
    expect(await runEvalWorker<string>(echo, null, opts)).toBe("alive");
  });

  test("a body that exits without answering is named by its label", async () => {
    await expect(runEvalWorker("process.exit(3)", null, opts)).rejects.toThrow(
      "probe ended without a result (worker exit 3)",
    );
  });

  test("an uncaught throw in the body rejects with that error", async () => {
    await expect(runEvalWorker('throw new Error("boom")', null, opts)).rejects.toThrow("boom");
  });
});
