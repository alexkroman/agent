// Copyright 2026 the AAI authors. MIT license.
/**
 * "Is a workflow really stateless?" — the harness that answers it by killing the
 * host after EVERY journaled step.
 *
 * The claim `workflow()` sells is that a run outlives the process running it. The
 * engine's own suite tests the PIECES of that (a lease expires, `due()` reports
 * the run, replay short-circuits a journaled step) and never composes them into
 * the whole sentence, so nothing asserted the property an author actually relies
 * on: a run stepped through N restarts finishes once, with every step body having
 * run exactly once.
 *
 * **A restart is a new ENGINE over the same store, and that is the whole of it** —
 * which is the point rather than a shortcut. Everything the engine keeps in
 * process is per-engine (`inFlight`, `controllers`, wake `timers`, `namesOf`, the
 * memoized `init()`, the context factory); the store is the only thing that
 * crosses a restart. So `close()` plus a fresh `createWorkflowEngine` over the
 * same store IS the production event — and if engine state ever escapes into a
 * module scope, this harness stops proving anything, which is why it asserts on
 * step BODIES rather than on the run's output. An output can be perfectly correct
 * while every step ran four times.
 *
 * **Where the crash lands is the experiment, not an implementation detail.** The
 * workflow parks at a gate BETWEEN steps, so the host dies with step `i` durable
 * and nothing in flight — the one instant where the guarantee is exactly-once.
 * Crashing INSIDE a step body is the other case and is at-least-once by design
 * (`ctx.step`'s own doc says so): `fn` returned but the journal write had not
 * landed, so the retry re-runs it. Both are covered in
 * `workflow-restart.test.ts`; only the between-steps one may assert a count of 1,
 * and conflating them is how a suite comes to "prove" a guarantee the engine does
 * not make.
 *
 * The engine is built by the CALLER, not here, because what a restart replaces
 * differs per tier: the fast tier swaps the engine alone, while the real-Postgres
 * tier swaps the connection pool with it (see that file's doc).
 */

import { type WorkflowDef, workflow } from "../sdk/workflow.ts";
import type { WorkflowEngine } from "./workflow-engine.ts";
import type { WorkflowStore } from "./workflow-store.ts";

/** Steps the chained workflow takes. Four is enough to restart between each. */
export const RESTART_STEPS = 4;

/** A gate the workflow waits at, released by the harness. */
type Gate = { readonly promise: Promise<void>; open(): void };

function createGate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/**
 * Wait for `gate`, or throw when the host closes.
 *
 * The throw is what makes a close look like a crash: it unwinds `run` the way a
 * real abort does, so `settleFailure` takes its `shutdown.aborted` branch and
 * leaves the run `running` with its journal intact. Awaiting the gate alone would
 * leave a promise nothing resolves, and the run would look hung rather than
 * abandoned.
 */
function waitAtGate(gate: Gate, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("host closed"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("host closed"));
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** One step's journaled output — an OBJECT, so a bad round trip is a type error. */
export type RestartStepOutput = { index: number; doubled: number };

/** The gated workflow plus what it records, for the caller to assert on. */
export type RestartProbe = {
  /**
   * Times each step's BODY was entered, by step index.
   *
   * The assertion this harness exists for: every entry is 1, however many times
   * the run was replayed. A journaled step must not re-run.
   */
  readonly bodyRuns: number[];
  /**
   * Times the run reached the gate after each step, by step index.
   *
   * Grows with every replay that passes an already-open gate, so it is a PROGRESS
   * signal rather than an invariant — the harness waits on it to know a replay has
   * caught up to where the last host died.
   */
  readonly arrivals: number[];
  /** Release the gate after step `index`, letting the run move on. */
  open(index: number): void;
  /** The `workflows` record to hand `createWorkflowEngine`. */
  readonly workflows: Readonly<Record<string, WorkflowDef>>;
};

/** Name the chain is declared under, so callers and `start()` cannot disagree. */
export const RESTART_WORKFLOW = "chain";

/** Build the gated chain and the counters that observe it. */
export function createRestartProbe(): RestartProbe {
  const bodyRuns: number[] = Array.from({ length: RESTART_STEPS }, () => 0);
  const arrivals: number[] = Array.from({ length: RESTART_STEPS }, () => 0);
  const gates: Gate[] = Array.from({ length: RESTART_STEPS }, () => createGate());

  const chain = workflow({
    description: "A chain of steps with a parking spot between each",
    async run(_input: unknown, ctx) {
      const seen: number[] = [];
      for (let i = 0; i < RESTART_STEPS; i++) {
        // The step name carries the INDEX rather than reusing one name across the
        // loop: a harness whose correctness depends on the ordinal-disambiguation
        // rule cannot also be evidence about it.
        const value: RestartStepOutput = await ctx.step(`step-${i}`, () => {
          bodyRuns[i] = (bodyRuns[i] ?? 0) + 1;
          return Promise.resolve({ index: i, doubled: i * 2 });
        });
        // Read a NUMERIC field back out, so a journal that returned this object
        // as a JSON string fails here instead of passing a looser assertion.
        seen.push(value.doubled);
        // BETWEEN steps: a close here finds the journal settled and nothing in
        // flight — see the module doc.
        arrivals[i] = (arrivals[i] ?? 0) + 1;
        // Non-null: `gates` is built at the same length as this loop's bound.
        await waitAtGate(gates[i] as Gate, ctx.signal);
      }
      return { seen };
    },
  });

  return {
    bodyRuns,
    arrivals,
    open: (index: number) => gates[index]?.open(),
    workflows: { [RESTART_WORKFLOW]: chain },
  };
}

/** What the chain returns once it has survived every restart. */
export const RESTART_EXPECTED_OUTPUT = {
  seen: Array.from({ length: RESTART_STEPS }, (_unused, i) => i * 2),
};

/** One booted host: the engine, and the store it reads its journal from. */
export type BootedHost = {
  engine: WorkflowEngine;
  store: WorkflowStore;
  /**
   * Make this host's claim lapse, as `WORKFLOW_LEASE_MS` elapsing would.
   *
   * Waiting the real two minutes per step would observe nothing new — the claim
   * rule being exercised is `lease_until < now()` either way — so each tier
   * expires it the way its own store allows.
   */
  expireLease(runId: string): Promise<void>;
  /** Release anything the boot acquired beyond the engine (a connection pool). */
  shutdown(): Promise<void>;
};

/** Assertion hooks, injected so this module carries no vitest dependency. */
export type RestartAssertions = {
  waitFor(check: () => boolean | Promise<boolean>): Promise<void>;
  equal(actual: unknown, expected: unknown, label: string): void;
};

/**
 * Drive one run through a restart after every step, asserting as it goes.
 *
 * Shared by both tiers so the memory store and a real Postgres are held to the
 * SAME sentence: a difference between them is then a difference in the store,
 * which is the only thing the two runs do not have in common.
 *
 * The assertions live here rather than in the callers because they are
 * POSITIONAL — "no journaled step has re-run" is only checkable at the two
 * instants this loop knows about: just before a restart, and once the replay has
 * caught up to the same point.
 *
 * Resolves with the run id and the last host, which the caller closes.
 */
export async function stepThroughRestarts(
  probe: RestartProbe,
  boot: () => Promise<BootedHost>,
  assert: RestartAssertions,
): Promise<{ runId: string; host: BootedHost }> {
  let host = await boot();
  const runId = await host.engine.start(RESTART_WORKFLOW, {});

  for (let i = 0; i < RESTART_STEPS; i++) {
    // The run has journaled step `i` and is parked past it.
    await assert.waitFor(() => (probe.arrivals[i] ?? 0) > 0);
    const arrivalsBefore = probe.arrivals[i] ?? 0;
    const settled = Array.from({ length: i + 1 }, () => 1);
    assert.equal(
      (await host.store.completedSteps(runId)).size,
      i + 1,
      `steps journaled before restart ${i}`,
    );
    assert.equal(probe.bodyRuns.slice(0, i + 1), settled, `step bodies run before restart ${i}`);

    // THE RESTART. Nothing of this host survives but what it wrote.
    host.engine.close();
    await host.expireLease(runId);
    const dead = host;
    host = await boot();
    await dead.shutdown();
    // `runDue()` is the cold-start sweep a booting host runs. Not awaited: it
    // does not resolve until the run reaches its next boundary, and the run is
    // about to park at the gate below.
    void host.engine.runDue();

    // The fresh host replayed to exactly where the last one died...
    await assert.waitFor(() => (probe.arrivals[i] ?? 0) > arrivalsBefore);
    // ...and re-ran none of the journaled work getting there. This is the
    // assertion the whole harness exists for.
    assert.equal(probe.bodyRuns.slice(0, i + 1), settled, `step bodies run after restart ${i}`);

    probe.open(i);
  }

  await assert.waitFor(async () => (await host.store.get(runId))?.status === "completed");
  return { runId, host };
}
