// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared harness for the workflow-engine suites.
 *
 * Extracted when `workflow-engine.test.ts` reached the 700-line test cap and the
 * waitpoint specs moved to their own file: both need the same two helpers, and a
 * second copy of `makeEngine` is how two suites end up asserting against engines
 * configured differently without either file saying so.
 */

import { vi } from "vitest";
import type { WorkflowDef } from "../sdk/workflow.ts";
import { createMemoryWorkflowStore, type MemoryWorkflowStore } from "./_workflow-test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";

/**
 * Drain the microtask chain a run executes on, without spending wall-clock
 * time. `start()` deliberately does not await `execute` (that is the whole
 * point of it), so a spec has to pump the loop to observe the outcome —
 * `vi.waitFor` would poll in REAL time against fake timers, which is the one
 * thing the repo's timer guidance says not to do.
 */
export async function drain(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

export function makeEngine(
  workflows: Record<string, WorkflowDef>,
  store: MemoryWorkflowStore = createMemoryWorkflowStore(),
): {
  engine: WorkflowEngine;
  store: MemoryWorkflowStore;
  logger: { error: ReturnType<typeof vi.fn> };
} {
  // Returned rather than discarded: the determinism-drift report has no other
  // observable effect — it deliberately does not fail the run — so the log IS the
  // behaviour under test.
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engine = createWorkflowEngine({
    workflows,
    store,
    db: { query: () => Promise.resolve([]) },
    env: { API_KEY: "k" },
    generate: undefined,
    logger,
  });
  return { engine, store, logger };
}
