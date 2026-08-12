// Copyright 2026 the AAI authors. MIT license.
/**
 * A run survives a restart after every step — the fast tier.
 *
 * The harness and the reasoning are in `_workflow-restart-harness.ts`; what this
 * file adds is the memory store and the OTHER half of the guarantee, the
 * at-least-once one. Read the two tests together — they are the same crash at two
 * different instants, and the contract is which count each one may assert.
 *
 * The real-Postgres run of the first property is
 * `host/integration/workflow-restart.integration.test.ts`. This tier cannot see an
 * encoding bug in the journal (the memory store holds JS values — see the
 * `::text::jsonb` note in `workflow-store.ts`), so it proves the ENGINE is
 * stateless and says nothing about whether the journal round-trips. That is why
 * both exist.
 */

import { describe, expect, test, vi } from "vitest";
import { createUnusedDb } from "../sdk/testing.ts";
import { type WorkflowDef, workflow } from "../sdk/workflow.ts";
import { silentLogger } from "./_test-utils.ts";
import {
  type BootedHost,
  createRestartProbe,
  RESTART_EXPECTED_OUTPUT,
  RESTART_STEPS,
  type RestartProbe,
  stepThroughRestarts,
} from "./_workflow-restart-harness.ts";
import {
  asStatus,
  createMemoryWorkflowStore,
  type MemoryWorkflowStore,
} from "./_workflow-test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";

/** `vi.waitFor` resolves on "did not throw", so a predicate has to throw. */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(async () => {
    if (!(await check())) throw new Error("condition not met yet");
  });
}

/** An engine over `store`, as one host process would build it. */
function engineOver(
  store: MemoryWorkflowStore,
  workflows: Readonly<Record<string, WorkflowDef>>,
): WorkflowEngine {
  return createWorkflowEngine({
    workflows,
    store,
    db: createUnusedDb(),
    env: {},
    generate: undefined,
    logger: silentLogger,
  });
}

/**
 * Boot a host over one shared memory store.
 *
 * Only the ENGINE is replaced here: a memory store has no connection pool to
 * rebuild, and it stands in for the database, which a restart does not restart.
 */
function bootOver(store: MemoryWorkflowStore, probe: RestartProbe): () => Promise<BootedHost> {
  return () =>
    Promise.resolve({
      engine: engineOver(store, probe.workflows),
      store,
      expireLease(runId: string): Promise<void> {
        store.row(runId).leaseUntil = Date.now() - 1;
        return Promise.resolve();
      },
      shutdown: () => Promise.resolve(),
    });
}

describe("a workflow run is stateless across host restarts", () => {
  test(`survives a restart after each of its ${RESTART_STEPS} steps, running each step once`, async () => {
    const store = createMemoryWorkflowStore();
    const probe = createRestartProbe();
    // Built INSIDE the test: Biome's `noMisplacedAssertion` reads an `expect` in a
    // module-scope helper as a stray assertion, and it is right to — the adapter
    // only means anything for the duration of a test.
    const assertions = {
      waitFor,
      equal(actual: unknown, expected: unknown, label: string): void {
        expect(actual, label).toEqual(expected);
      },
    };

    const { runId, host } = await stepThroughRestarts(probe, bootOver(store, probe), assertions);
    host.engine.close();

    // The output is correct AND was produced by running each step body once. The
    // second half is what a correct output cannot demonstrate on its own.
    expect(asStatus(await store.get(runId), "completed").output).toEqual(RESTART_EXPECTED_OUTPUT);
    expect(probe.bodyRuns).toEqual(Array.from({ length: RESTART_STEPS }, () => 1));
    expect((await store.completedSteps(runId)).size).toBe(RESTART_STEPS);
  });

  test("a crash INSIDE a step re-runs that step — at-least-once, as documented", async () => {
    // The companion to the test above, and the reason that one may assert a count
    // of 1: it crashes BETWEEN steps, where the journal is settled. Crash while
    // `fn` is in flight and the step has no journal row, so the retry must re-run
    // it. An author's external side effect wants an idempotency key BECAUSE of
    // this case, so it is pinned rather than merely described.
    const store = createMemoryWorkflowStore();
    let attempts = 0;
    const { promise: reached, resolve: entered } = Promise.withResolvers<void>();

    const risky = workflow({
      run: (_input: unknown, ctx) =>
        ctx.step("charge", async () => {
          attempts += 1;
          if (attempts === 1) {
            entered();
            // Never settles on its own: the close is what ends this attempt,
            // with `fn` having done its work and journaled nothing.
            await new Promise<void>((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => reject(new Error("host closed")), {
                once: true,
              });
            });
          }
          return { attempts };
        }),
    });

    const first = engineOver(store, { risky });
    const runId = await first.start("risky", {});
    await reached;
    expect((await store.completedSteps(runId)).size, "nothing journaled mid-step").toBe(0);

    first.close();
    store.row(runId).leaseUntil = Date.now() - 1;
    const second = engineOver(store, { risky });
    await second.runDue();
    second.close();

    // Two attempts, one journal row: the step body ran twice and succeeded once.
    expect(attempts).toBe(2);
    expect(asStatus(await store.get(runId), "completed").output).toEqual({ attempts: 2 });
    expect((await store.completedSteps(runId)).size).toBe(1);
  });
});
