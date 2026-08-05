// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving tests for the studio's two async pipelines — the
 * durable preview-deploy queue and the SSE event streams.
 *
 * These are property tests, not scenario tests: fast-check builds a different
 * interleaving of edits, drains, deploy failures, pushes, disconnects, and
 * shutdowns on every run, then asserts invariants that must hold for EVERY
 * interleaving. The example-based suites next door
 * (`studio-preview-deploy.test.ts`, `studio-sse.test.ts`) pin the specific
 * orderings that once broke; this one covers the orderings nobody thought to
 * write down. Both matter — the bugs here are the kind that survive a green
 * example suite because they need three things to land in one particular order.
 *
 * ## `fc.scheduler` owns the async ordering
 *
 * The async interleaving is NOT a random number of microtask yields sprinkled
 * through the production code's awaits (which is what this harness did before,
 * via a `jitter()` helper). Every await whose ordering matters — a deploy
 * resuming, an SSE producer settling, a frame being written — is registered
 * with fast-check's scheduler, which decides the order and, crucially, SHRINKS
 * it. A failure therefore reports the shortest op sequence and the exact
 * interleaving that breaks the invariant, instead of a seed to re-run.
 *
 * The scheduler wraps the resumption INSIDE the deploy body rather than the
 * deploy function itself (`s.schedule` in the body, not `s.scheduleFunction`
 * around it): the scheduler runs task bodies one at a time to completion, so
 * wrapping the whole function would serialize deploys and make the
 * "no concurrent deploy per project" invariant unfalsifiable — the harness
 * would report success by construction.
 *
 * The invariants, and what each one being false looks like in production:
 *
 * - **Convergence.** Once the queue is drained, every project's `previewHash`
 *   matches its files. False = the Preview pane sits on "Updating preview…"
 *   forever with a finished workspace behind it, which is the exact failure the
 *   queue replaced an in-process dirty bit to prevent.
 * - **No concurrent deploy per project.** Two deploys of one project race to
 *   stamp the workspace, and the loser's hash can be the older snapshot.
 * - **Archive only past the attempt cap.** Archiving early drops work silently;
 *   never archiving redelivers a crash loop forever.
 * - **No write after a stream ends.** A write into a response hono has closed
 *   is a chunked-body protocol error to whatever is reading (in production,
 *   Modal's ASGI proxy).
 * - **Frame order.** Frames are re-reads of a row; delivering an older one
 *   after a newer one leaves the client stale with no correction coming.
 * - **Exactly one cleanup, no registry leak.** The live-stream registry is
 *   process-global, so a leaked ender is called at shutdown for a response
 *   that already completed.
 */

import {
  endLiveStreams,
  liveStreamCount,
  registerLiveStream,
  resetLiveStreams,
} from "aai-server/live-streams";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import fc from "fast-check";
import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPreviewDeployer } from "./studio-preview.ts";
import {
  createMemoryPreviewQueue,
  PREVIEW_JOB_MAX_ATTEMPTS,
  PREVIEW_JOB_VISIBILITY_MS,
} from "./studio-preview-queue.ts";
import { createSsePusher } from "./studio-sse.ts";
import { currentFilesHash, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECTS = ["alpha-a1b2c3", "beta-d4e5f6", "gamma-g7h8i9"];

/**
 * How a deploy ends. Weights mirror the roll thresholds this harness used
 * before: mostly success, with a build error (settled — no redelivery) and a
 * dead sandbox (throws — redelivered) each about one in seven.
 */
type DeployOutcome = "ok" | "buildError" | "throw";

const outcomeArb: fc.Arbitrary<DeployOutcome> = fc.oneof(
  { weight: 70, arbitrary: fc.constant("ok" as const) },
  { weight: 15, arbitrary: fc.constant("buildError" as const) },
  { weight: 15, arbitrary: fc.constant("throw" as const) },
);

/** One operation against the preview pipeline. */
type PreviewOp =
  | { kind: "edit"; project: number }
  | { kind: "drain" }
  | { kind: "advanceClock" }
  | { kind: "advanceScheduler" };

const previewOpArb: fc.Arbitrary<PreviewOp> = fc.oneof(
  {
    weight: 45,
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      project: fc.nat({ max: PROJECTS.length - 1 }),
    }),
  },
  { weight: 35, arbitrary: fc.record({ kind: fc.constant("drain" as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("advanceClock" as const) }) },
  { weight: 12, arbitrary: fc.record({ kind: fc.constant("advanceScheduler" as const) }) },
);

/**
 * States the generator must actually reach, asserted as floors after the run.
 *
 * fast-check has no coverage-floor mechanism (`fc.statistics` only prints), and
 * an all-green property proves nothing about a state the generator never
 * entered — so these stay hand-rolled.
 *
 * Measuring them is what showed the archive path was unreachable HERE and in
 * the pre-fast-check harness alike (zero archives over 200 seeds and 100 runs
 * respectively): reaching it needs six alternating clock-advance/drain pairs
 * with every deploy throwing, which a random walk over 40 ops effectively never
 * produces. A floor cannot fix that — asking the walk to hit a six-step
 * sequence is what a targeted property is for, so the attempt-cap boundary got
 * one of its own below rather than a floor here.
 */
type Reached = { buildErrors: number; redelivered: number };
const reached: Reached = { buildErrors: 0, redelivered: 0 };

type MemoryQueue = ReturnType<typeof createMemoryPreviewQueue>;

/**
 * Wrap a memory queue to count redeliveries. A counter in the queue itself
 * would be production code carrying a field only a test reads; claims are
 * observable from out here.
 */
function countingQueue(inner: MemoryQueue): MemoryQueue {
  return {
    ...inner,
    async claim(max: number) {
      const claimed = await inner.claim(max);
      reached.redelivered += claimed.filter((job) => job.attempts > 1).length;
      return claimed;
    },
  };
}

/**
 * One interleaving of the preview pipeline: edits that enqueue jobs, drains
 * that claim and run them, and deploys that succeed, fail (a build error —
 * settled), or throw (a dead sandbox — redelivered).
 */
async function runPreviewPipeline(
  s: fc.Scheduler,
  ops: readonly PreviewOp[],
  outcomes: readonly DeployOutcome[],
): Promise<string[]> {
  const problems: string[] = [];
  const store = createMemoryWorkspaceStore();
  for (const project of PROJECTS) {
    await store.put(SCOPE, project, { files: { "agent.ts": "// v0" }, updatedAt: 0 }, null);
  }

  // A virtual clock: a job whose deploy THREW is left unacked on purpose and
  // stays invisible for the visibility timeout. Real time cannot reach past
  // that inside a test, so quiescing below advances this instead.
  let clock = 1;
  const queue = countingQueue(createMemoryPreviewQueue({ now: () => clock }));

  const inFlight = new Map<string, number>();
  let quiescing = false;
  let deployIndex = 0;
  const deployWorkspace = async (_scope: string, project: string): Promise<unknown> => {
    const depth = (inFlight.get(project) ?? 0) + 1;
    inFlight.set(project, depth);
    if (depth > 1) problems.push(`${depth} concurrent deploys of ${project}`);
    try {
      // The scheduler decides when this deploy resumes — the interleaving under
      // test. Scheduling here rather than around the whole function is what
      // keeps two overlapping deploy bodies observable; see the module doc.
      await s.schedule(Promise.resolve(), `deploy ${project}`);
      // Quiescing deploys always succeed, so the convergence check below is
      // about lost work rather than about the last roll of the dice.
      const outcome = quiescing
        ? "ok"
        : (outcomes[deployIndex++ % outcomes.length] as DeployOutcome);
      if (outcome === "throw") throw new Error("sandbox died mid-deploy");
      if (outcome === "buildError") {
        reached.buildErrors += 1;
        return { ok: false, output: "build error: missing ;" };
      }
      return { ok: true, slug: `${project}-preview` };
    } finally {
      inFlight.set(project, (inFlight.get(project) ?? 1) - 1);
    }
  };

  const deployer = createPreviewDeployer({
    workspaces: store,
    deployWorkspace: deployWorkspace as never,
    queue,
    // The timer is off: the interleaving drives `drainOnce` itself, so a run
    // replays identically instead of depending on wall-clock timing.
    pollMs: 0,
  });

  const pending: Promise<unknown>[] = [];
  const edited = new Set<string>();
  for (const [op, action] of ops.entries()) {
    if (action.kind === "edit") {
      const project = PROJECTS[action.project] as string;
      edited.add(project);
      pending.push(
        mutateWorkspace(store, SCOPE, project, (current) => ({
          ...current,
          files: { ...current.files, "agent.ts": `// v${op}` },
        })).then(() => {
          deployer.schedule(SCOPE, project, {
            serverUrl: "https://platform.example",
            apiKey: "caller-key",
          });
        }),
      );
    } else if (action.kind === "drain") {
      pending.push(deployer.drainOnce());
    } else if (action.kind === "advanceClock") {
      // Step past a visibility window DURING the op phase, so a job whose
      // deploy threw comes back while deploys can still fail — the only way to
      // accumulate attempts up to the archive cap (quiescing forces success).
      clock += PREVIEW_JOB_VISIBILITY_MS + 1;
    } else if (s.count() > 0) {
      // Let one held deploy resume mid-sequence, so a deploy settles while
      // later edits and drains are still arriving.
      await s.waitNext(1);
    } else {
      await Promise.resolve();
    }
  }
  await s.waitIdle();
  await Promise.all(pending);

  // Quiesce: step past each visibility window so redelivered jobs come back,
  // and drain until there is nothing left to run. `waitFor` releases exactly
  // the scheduled deploys this drain needs, so a round can never deadlock on a
  // task the drain itself has not created yet.
  quiescing = true;
  for (let round = 0; round < PREVIEW_JOB_MAX_ATTEMPTS + 4; round += 1) {
    clock += PREVIEW_JOB_VISIBILITY_MS + 1;
    await s.waitFor(deployer.drainOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  deployer.dispose();

  problems.push(...(await checkPreviewOutcome(store, queue, edited)));
  return problems;
}

/**
 * The post-quiesce assertions: every project the interleaving edited either
 * has a preview matching its files or SETTLED on a reason that deliberately
 * ends the job — a stamped `previewError` (a build failure is deterministic,
 * so retrying would only rewrite the same banner) or an archive at the attempt
 * cap (the crash-loop escape hatch). Anything else is lost work.
 */
async function checkPreviewOutcome(
  store: ReturnType<typeof createMemoryWorkspaceStore>,
  queue: ReturnType<typeof createMemoryPreviewQueue>,
  edited: Set<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const project of edited) {
    const workspace = await getWorkspace(store, SCOPE, project);
    if (!workspace) {
      problems.push(`${project} vanished`);
      continue;
    }
    const settled =
      Boolean(workspace.previewError) || queue.archived.some((job) => job.job.project === project);
    if (workspace.previewHash !== currentFilesHash(workspace) && !settled) {
      problems.push(
        `${project} never converged — stamped ${String(workspace.previewHash).slice(0, 8)}, files ${currentFilesHash(workspace).slice(0, 8)}`,
      );
    }
  }
  for (const job of queue.archived) {
    if (job.attempts <= PREVIEW_JOB_MAX_ATTEMPTS) {
      problems.push(`archived after only ${job.attempts} attempts`);
    }
  }
  return problems;
}

test("preview queue: every interleaving converges, one deploy per project at a time", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(previewOpArb, { minLength: 1, maxLength: 40 }),
      fc.array(outcomeArb, { minLength: 1, maxLength: 40 }),
      async (s, ops, outcomes) => {
        expect(await runPreviewPipeline(s, ops, outcomes)).toEqual([]);
      },
    ),
    { numRuns: 100 },
  );

  // Coverage floors — see `Reached`. Set well below measured actuals (noted
  // alongside) because what a random walk reaches varies run to run: these
  // exist to catch a generator that stopped reaching a state, not to pin a
  // count. A sudden drop here is a broken generator, not a fixed bug.
  expect(reached.buildErrors, "no deploy ever failed its build").toBeGreaterThan(10); // ~35
  expect(reached.redelivered, "no job was ever redelivered").toBeGreaterThan(5); // ~40
}, 120_000);

/**
 * The attempt-cap boundary, in both directions. A crash-looping job must be
 * archived — a redelivery that never stops is the failure the cap exists for —
 * and it must NOT be archived early, since an archive is silently dropped work.
 *
 * Its own property rather than a floor on the walk above: every deploy has to
 * throw and the clock has to step past six visibility windows, a six-step
 * sequence a random 40-op walk effectively never generates (measured: zero
 * archives in 100 runs, and in 200 seeds of the harness this replaced).
 */
test("preview queue: a crash-looping job is archived past the cap, never before", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.integer({ min: 1, max: PREVIEW_JOB_MAX_ATTEMPTS + 4 }),
      async (s, rounds) => {
        let clock = 1;
        const store = createMemoryWorkspaceStore();
        await store.put(SCOPE, "alpha-a1b2c3", { files: { "a.ts": "//" }, updatedAt: 0 }, null);
        const queue = createMemoryPreviewQueue({ now: () => clock });
        const deployer = createPreviewDeployer({
          workspaces: store,
          // Every deploy dies mid-flight: the job is left unacked and comes
          // back on the next visibility window.
          deployWorkspace: (async () => {
            await s.schedule(Promise.resolve(), "deploy");
            throw new Error("sandbox died mid-deploy");
          }) as never,
          queue,
          pollMs: 0,
        });
        deployer.schedule(SCOPE, "alpha-a1b2c3", {
          serverUrl: "https://platform.example",
          apiKey: "caller-key",
        });
        for (let round = 0; round < rounds; round += 1) {
          clock += PREVIEW_JOB_VISIBILITY_MS + 1;
          await s.waitFor(deployer.drainOnce());
        }
        await s.waitIdle();
        deployer.dispose();

        // Safety, for every `rounds`: an archive means the cap was passed.
        for (const job of queue.archived) {
          expect(job.attempts, "archived before the attempt cap").toBe(
            PREVIEW_JOB_MAX_ATTEMPTS + 1,
          );
        }
        // Liveness, once there have been enough windows: the loop terminates.
        // `schedule` kicks its own drain, so claims can only run ahead of
        // `rounds`, never behind — hence `>=` rather than an exact round.
        if (rounds >= PREVIEW_JOB_MAX_ATTEMPTS + 2) {
          expect(queue.archived, "a crash-looping job was never archived").toHaveLength(1);
        }
      },
    ),
    { numRuns: 60 },
  );
}, 120_000);

beforeEach(() => resetLiveStreams());
afterEach(() => resetLiveStreams());

/** One operation against a live event stream. */
type SseOp =
  | { kind: "push" }
  | { kind: "rowVanished" }
  | { kind: "clientDisconnect" }
  | { kind: "scaleIn" }
  | { kind: "advanceScheduler" };

const sseOpArb: fc.Arbitrary<SseOp> = fc.oneof(
  { weight: 62, arbitrary: fc.record({ kind: fc.constant("push" as const) }) },
  { weight: 10, arbitrary: fc.record({ kind: fc.constant("rowVanished" as const) }) },
  { weight: 10, arbitrary: fc.record({ kind: fc.constant("clientDisconnect" as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("scaleIn" as const) }) },
  { weight: 10, arbitrary: fc.record({ kind: fc.constant("advanceScheduler" as const) }) },
);

/** The mutable bookkeeping one SSE interleaving accumulates. */
type SseWorld = {
  written: string[];
  queued: string[];
  ended: boolean;
  writesAfterEnd: number;
  cleanups: number;
};

/**
 * One interleaving of an event stream's life: bursts of pushes whose producers
 * settle out of order, a client disconnect, a vanished row, and a shutdown
 * drain — in whatever order the generated op list picks.
 */
async function runSsePusher(s: fc.Scheduler, ops: readonly SseOp[]): Promise<string[]> {
  const problems: string[] = [];
  const w: SseWorld = { written: [], queued: [], ended: false, writesAfterEnd: 0, cleanups: 0 };
  let onAbort = (): void => undefined;
  const stream = {
    writeSSE: async (frame: { event?: string; data: string }) => {
      // Checked on both sides of the await: a write must not be STARTED after
      // the stream ended, and the response may close while one is in flight.
      if (w.ended) w.writesAfterEnd += 1;
      await s.schedule(Promise.resolve(), `write ${frame.data}`);
      w.written.push(`${frame.event}:${frame.data}`);
    },
    onAbort: (callback: () => void) => {
      onAbort = callback;
    },
  } as unknown as SSEStreamingApi;

  const sse = createSsePusher(stream);
  const held = sse.wait(() => {
    w.cleanups += 1;
  });
  // Mark the end at the instant it happens, not when the cleanup callback
  // later runs — a write started in between is a write into a closing response.
  const endNow = (end: () => void): void => {
    w.ended = true;
    end();
  };

  for (const [op, action] of ops.entries()) {
    if (action.kind === "push") {
      w.queued.push(`project:${op}`);
      sse.push(async () => {
        await s.schedule(Promise.resolve(), `produce ${op}`);
        return { event: "project", data: String(op) };
      });
    } else if (action.kind === "rowVanished") {
      // The watched row vanished (project deleted) — ends the stream.
      sse.push(async () => {
        w.ended = true;
        return null;
      });
    } else if (action.kind === "clientDisconnect") {
      endNow(onAbort);
    } else if (action.kind === "scaleIn") {
      endNow(endLiveStreams);
    } else if (s.count() > 0) {
      // Let one held producer or write settle mid-sequence.
      await s.waitNext(1);
    }
  }

  // A generated op list need not contain an end at all, and `held` only
  // resolves once the stream ends — so close it here when nothing else did.
  // A shutdown drain is a legitimate terminal event for any of these streams,
  // and it keeps the end-exactly-once invariant meaningful for every run.
  if (!w.ended) endNow(endLiveStreams);

  await s.waitFor(held);
  await s.waitIdle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...problems, ...checkSseOutcome(w)];
}

function checkSseOutcome(w: SseWorld): string[] {
  const problems: string[] = [];
  if (w.cleanups !== 1) problems.push(`cleanup ran ${w.cleanups} times`);
  if (w.writesAfterEnd > 0) problems.push(`${w.writesAfterEnd} writes into an ended stream`);
  if (liveStreamCount() !== 0) problems.push("leaked a live-stream ender");
  // Delivered frames must be an in-order subsequence of what was pushed:
  // producers settle out of order, the chain does not.
  const positions = w.written
    .filter((frame) => frame.startsWith("project:"))
    .map((frame) => w.queued.indexOf(frame));
  for (let i = 1; i < positions.length; i += 1) {
    if ((positions[i] as number) <= (positions[i - 1] as number)) {
      problems.push(`frames out of order — ${w.written.join(", ")}`);
      break;
    }
  }
  return problems;
}

test("SSE pusher: no write survives the stream's end, and frames stay ordered", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(sseOpArb, { minLength: 1, maxLength: 20 }),
      async (s, ops) => {
        resetLiveStreams();
        expect(await runSsePusher(s, ops)).toEqual([]);
      },
    ),
    { numRuns: 200 },
  );
}, 120_000);

/**
 * The live-stream registry under arbitrary register/unregister/shutdown
 * interleavings. It is process-global and latches closed, so the two things
 * that can go wrong are a stale ender surviving its response and a stream
 * registered after the drain never being ended at all — the second is the
 * MODAL case, since the client's reconnect backoff is shorter than the
 * shutdown grace period.
 */
type RegistryOp = { kind: "register" } | { kind: "deregister"; which: number } | { kind: "drain" };

const registryOpArb: fc.Arbitrary<RegistryOp> = fc.oneof(
  { weight: 50, arbitrary: fc.record({ kind: fc.constant("register" as const) }) },
  {
    weight: 30,
    arbitrary: fc.record({
      kind: fc.constant("deregister" as const),
      which: fc.nat({ max: 1000 }),
    }),
  },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant("drain" as const) }) },
);

/** Register a stream whose ends are counted; returns its deregistration. */
function registerCounting(counts: Map<number, number>, id: number, extra?: () => void): () => void {
  return registerLiveStream(() => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    extra?.();
  });
}

/**
 * Once drained, the registry latches closed — a stream opened afterwards must
 * end ITSELF rather than wait for a drain that already happened. Not the rare
 * case: the client's reconnect backoff is shorter than the shutdown grace
 * period, so a resubscribe landing here is the modal one.
 */
function endsItselfAfterShutdown(): boolean {
  let endedImmediately = false;
  registerCounting(new Map(), -1, () => {
    endedImmediately = true;
  });
  return endedImmediately;
}

/** One interleaving of registrations, deregistrations, and shutdown drains. */
function runLiveStreamRegistry(ops: readonly RegistryOp[]): string[] {
  const problems: string[] = [];
  const endCounts = new Map<number, number>();
  const open: (() => void)[] = [];
  let next = 0;
  let drained = false;

  for (const action of ops) {
    if (action.kind === "register") {
      open.push(registerCounting(endCounts, next++));
    } else if (action.kind === "deregister" && open.length > 0) {
      open.splice(action.which % open.length, 1)[0]?.();
    } else if (action.kind === "drain") {
      endLiveStreams();
      drained = true;
    }
  }

  if (drained && !endsItselfAfterShutdown()) {
    problems.push("a stream opened during shutdown was never ended");
  }
  for (const [id, count] of endCounts) {
    if (count > 1) problems.push(`stream ${id} ended ${count} times`);
  }
  for (const unregister of open) unregister();
  if (liveStreamCount() !== 0) problems.push(`leaked ${liveStreamCount()}`);
  return problems;
}

test("live-stream registry: end-once, self-end after shutdown, never leak", () => {
  fc.assert(
    fc.property(fc.array(registryOpArb, { minLength: 1, maxLength: 30 }), (ops) => {
      resetLiveStreams();
      expect(runLiveStreamRegistry(ops)).toEqual([]);
    }),
    { numRuns: 300 },
  );
});
