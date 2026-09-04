// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving tests for the studio's durable preview-deploy queue.
 * Its sibling `studio-sse-fuzz.test.ts` does the same for the SSE event
 * streams and the live-stream registry; the two split when this file hit the
 * 700-line test cap, at the seam they already had — nothing is shared between
 * them but fast-check itself, and each coverage floor stays in the file whose
 * property feeds it.
 *
 * These are property tests, not scenario tests: fast-check builds a different
 * interleaving of edits, drains and deploy failures on every run, then asserts
 * invariants that must hold for EVERY interleaving. The example-based suite
 * next door (`studio-preview-deploy.test.ts`) pins the specific orderings that
 * once broke; this one covers the orderings nobody thought to write down. Both
 * matter — the bugs here are the kind that survive a green example suite
 * because they need three things to land in one particular order.
 *
 * ## `fc.scheduler` owns the async ordering
 *
 * The async interleaving is NOT a random number of microtask yields sprinkled
 * through the production code's awaits (which is what this harness did before,
 * via a `jitter()` helper). Every await whose ordering matters — a deploy
 * resuming — is registered with fast-check's scheduler, which decides the
 * order and, crucially, SHRINKS it. A failure therefore reports the shortest
 * op sequence and the exact interleaving that breaks the invariant, instead of
 * a seed to re-run.
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
 * - **A settled `previewError` is a state the pipeline can LEAVE.** Convergence
 *   used to count any stamped error as settled and walk past it, which made
 *   this harness blind to a banner over already-deployed files — the failure
 *   an undo leaves behind, and one nothing but another deploy could clear.
 * - **No concurrent deploy per project.** Two deploys of one project race to
 *   stamp the workspace, and the loser's hash can be the older snapshot.
 * - **Archive only past the attempt cap.** Archiving early drops work silently;
 *   never archiving redelivers a crash loop forever.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { captureLogs } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import fc from "fast-check";
import { expect, test } from "vitest";
import { createPreviewDeployer, type PreviewDeployerOptions } from "./studio-preview.ts";
import {
  createMemoryPreviewQueue,
  PREVIEW_JOB_MAX_ATTEMPTS,
  PREVIEW_JOB_VISIBILITY_MS,
} from "./studio-preview-queue.ts";
import { filesHash, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

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

/**
 * File contents an edit may write. A SMALL pool rather than a per-op unique
 * string, so an edit CAN restore a content the project already held — an undo,
 * which the per-op `// v${index}` string made unrepresentable. Not enough on
 * its own to reach the stale-banner state (see the invariant that names it).
 */
const CONTENTS = ["// v0", "// v1", "// v2"];

/** One operation against the preview pipeline. */
type PreviewOp =
  | { kind: "edit"; project: number; content: number }
  | { kind: "drain" }
  | { kind: "advanceClock" }
  | { kind: "advanceScheduler" };

const previewOpArb: fc.Arbitrary<PreviewOp> = fc.oneof(
  {
    weight: 45,
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      project: fc.nat({ max: PROJECTS.length - 1 }),
      content: fc.nat({ max: CONTENTS.length - 1 }),
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
    const seed: Record<string, string> = { "agent.ts": CONTENTS[0] ?? "" };
    await store.put(SCOPE, project, { files: seed, hash: filesHash(seed), updatedAt: 0 }, null);
  }

  // A virtual clock: a job whose deploy THREW is left unacked on purpose and
  // stays invisible for the visibility timeout. Real time cannot reach past
  // that inside a test, so quiescing below advances this instead.
  let clock = 1;
  const queue = countingQueue(createMemoryPreviewQueue({ now: () => clock }));

  const inFlight = new Map<string, number>();
  let quiescing = false;
  let deployIndex = 0;
  // Typed as the seam it stands in for, not `Promise<unknown>` cast in with
  // `as never`: that cast also stops reporting the day `WorkspaceDeployOutcome`
  // gains a field, and a preview deploy's outcome shape is exactly what these
  // properties are about.
  const deployWorkspace: PreviewDeployerOptions["deployWorkspace"] = async (_scope, project) => {
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
      return { ok: true, slug: `${project}-preview`, output: "Deployed" };
    } finally {
      inFlight.set(project, (inFlight.get(project) ?? 1) - 1);
    }
  };

  const deployer = createPreviewDeployer({
    workspaces: store,
    deployWorkspace,
    queue,
    // The timer is off: the interleaving drives `drainOnce` itself, so a run
    // replays identically instead of depending on wall-clock timing.
    pollMs: 0,
  });

  const pending: Promise<unknown>[] = [];
  const edited = new Set<string>();
  for (const action of ops) {
    if (action.kind === "edit") {
      const project = PROJECTS[action.project] as string;
      edited.add(project);
      const content = CONTENTS[action.content] as string;
      pending.push(
        mutateWorkspace(store, SCOPE, project, (current) => ({
          ...current,
          files: { ...current.files, "agent.ts": content },
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
    await sleep(0);
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
 *
 * Plus the second half of what "settled" may mean, which this check was
 * missing: an error stamped over files that are ALREADY deployed is not a
 * settled failure, it is a permanent banner. See the invariant below.
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
    const archived = queue.archived.some((job) => job.job.project === project);
    const settled = Boolean(workspace.previewError) || archived;
    if (workspace.previewHash !== workspace.hash && !settled) {
      problems.push(
        `${project} never converged — stamped ${String(workspace.previewHash).slice(0, 8)}, files ${workspace.hash.slice(0, 8)}`,
      );
    }
    // A `previewError` is only SETTLED while the files it names are still
    // undeployed. Once the workspace is back at the deployed hash the deploy
    // no-ops, so the stamp is a banner nothing will ever clear — the state
    // this check used to read as "settled" and walk past, which is exactly why
    // the harness could not see that bug. (Archived is exempt: no job is left
    // to run, a different failure with its own invariant above.)
    //
    // MEASURED UNREACHABLE by this walk — reaching it needs a deploy to SETTLE
    // mid-phase, then a failure, then an edit back to exactly that content, and
    // the scheduler holds most deploys until the quiesce (0 hits in 5 runs of
    // 100 against the unfixed code). So the boundary has its own targeted
    // property below, the same shape as the archive cap, and this line covers
    // the interleavings that do reach it rather than pretending to be the gate.
    if (workspace.previewError && workspace.previewHash === workspace.hash && !archived)
      problems.push(`${project} kept a previewError over its deployed files`);
  }
  for (const job of queue.archived) {
    if (job.attempts <= PREVIEW_JOB_MAX_ATTEMPTS) {
      problems.push(`archived after only ${job.attempts} attempts`);
    }
  }
  return problems;
}

// Deploy failures are GENERATED here, so the warnings they produce are expected
// output, not a signal — hundreds of them per run. Silenced through the log
// seam, which is only possible now that this package logs through one.
captureLogs();

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
        await store.put(
          SCOPE,
          "alpha-a1b2c3",
          { files: { "a.ts": "//" }, hash: filesHash({ "a.ts": "//" }), updatedAt: 0 },
          null,
        );
        const queue = createMemoryPreviewQueue({ now: () => clock });
        const deployer = createPreviewDeployer({
          workspaces: store,
          // Every deploy dies mid-flight: the job is left unacked and comes
          // back on the next visibility window.
          deployWorkspace: async () => {
            await s.schedule(Promise.resolve(), "deploy");
            throw new Error("sandbox died mid-deploy");
          },
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

/**
 * The stale-banner boundary, which the walk above cannot reach (see the
 * invariant in `checkPreviewOutcome`): a build failure stamps `previewError`
 * while `previewHash` still names the last GOOD deploy, then the user UNDOES
 * the bad edit — so the files hash back to the stamp and the queued deploy has
 * nothing to do. Whatever the interleaving, the banner must end up gone: it
 * names code no longer in the workspace, and no later edit clears it either
 * (every one that hashes back here re-confirms it). Its own property for the
 * reason the attempt cap has one — five specific steps a 40-op walk never
 * produces.
 */
test("preview queue: an undo clears the banner its failed edit left", async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.integer({ min: 1, max: 3 }), async (s, extraJobs) => {
      const store = createMemoryWorkspaceStore();
      await store.put(
        SCOPE,
        "alpha-a1b2c3",
        { files: { "a.ts": "// v0" }, hash: filesHash({ "a.ts": "// v0" }), updatedAt: 0 },
        null,
      );
      const queue = createMemoryPreviewQueue();
      let ok = true;
      const deployer = createPreviewDeployer({
        workspaces: store,
        deployWorkspace: async () => {
          await s.schedule(Promise.resolve(), "deploy");
          return ok
            ? { ok: true, slug: "alpha-a1b2c3-preview", output: "Deployed" }
            : { ok: false, output: "boom" };
        },
        queue,
        pollMs: 0,
      });
      const target = { serverUrl: "https://platform.example", apiKey: "caller-key" };
      const edit = async (content: string): Promise<void> => {
        await mutateWorkspace(store, SCOPE, "alpha-a1b2c3", (current) => ({
          ...current,
          files: { ...current.files, "a.ts": content },
        }));
        deployer.schedule(SCOPE, "alpha-a1b2c3", target);
      };
      /** Run every job the edits queued, whatever order the scheduler picks. */
      const drain = async (): Promise<void> => {
        await s.waitFor(deployer.drainOnce());
        await s.waitIdle();
      };

      // A good deploy, so `previewHash` names content the workspace can be
      // put back to. Asserted, because an unstamped hash would make the rest
      // of this property describe a state it never reached.
      await edit("// good");
      await drain();
      const deployedHash = (await getWorkspace(store, SCOPE, "alpha-a1b2c3"))?.previewHash;
      expect(deployedHash, "the setup deploy never stamped").toBeDefined();

      // A bad edit that fails its build: the banner appears, and the stamp
      // still names the good deploy.
      ok = false;
      await edit("// broken");
      await drain();
      const failed = await getWorkspace(store, SCOPE, "alpha-a1b2c3");
      expect(failed?.previewError, "the failing build never stamped").toBeDefined();
      expect(failed?.previewHash).toBe(deployedHash);

      // The undo, plus however many duplicate jobs the burst enqueued. Every
      // one of them finds a workspace that hashes to the stamp, so not one
      // of them deploys — clearing the banner is the whole job.
      ok = true;
      for (let i = 0; i < extraJobs; i += 1) await edit("// good");
      for (let i = 0; i < extraJobs + 1; i += 1) await drain();
      deployer.dispose();

      const workspace = await getWorkspace(store, SCOPE, "alpha-a1b2c3");
      expect(workspace?.previewError, "the banner outlived the edit it described").toBeUndefined();
      // The stamp still names the deploy the undo returned to — compared
      // against the hash captured from THAT deploy rather than re-derived from
      // the document being asserted on (which needed a cast to read past its
      // own null, and made the claim nearly circular).
      expect(workspace?.previewHash).toBe(deployedHash);
    }),
    { numRuns: 40 },
  );
}, 120_000);
