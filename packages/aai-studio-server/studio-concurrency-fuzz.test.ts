// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving tests for the studio's two async pipelines — the
 * durable preview-deploy queue and the SSE event streams.
 *
 * These are property tests, not scenario tests: each seed builds a different
 * interleaving of edits, drains, deploy failures, pushes, disconnects, and
 * shutdowns, then asserts invariants that must hold for EVERY interleaving.
 * The example-based suites next door (`studio-preview-deploy.test.ts`,
 * `studio-sse.test.ts`) pin the specific orderings that once broke; this one
 * covers the orderings nobody thought to write down. Both matter — the bugs
 * here are the kind that survive a green example suite because they need three
 * things to land in one particular order.
 *
 * Every failure is reproducible: the PRNG is seeded, so a reported seed
 * replays its exact interleaving. Deploy duration, failure mode, and operation
 * choice all come from that one stream.
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

/**
 * xorshift32. Deliberately not `Math.random`: a property test whose failures
 * cannot be replayed reports a mystery instead of a bug.
 */
function seeded(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Yield a random number of microtasks, so awaits interleave differently. */
async function jitter(rand: () => number): Promise<void> {
  for (let i = Math.floor(rand() * 4); i > 0; i -= 1) await Promise.resolve();
}

const SCOPE = "scope";
const PROJECTS = ["alpha-a1b2c3", "beta-d4e5f6", "gamma-g7h8i9"];

/**
 * One interleaving of the preview pipeline: edits that enqueue jobs, drains
 * that claim and run them, and deploys that succeed, fail (a build error —
 * settled), or throw (a dead sandbox — redelivered).
 */
async function fuzzPreviewPipeline(seed: number): Promise<string[]> {
  const rand = seeded(seed);
  const problems: string[] = [];
  const store = createMemoryWorkspaceStore();
  for (const project of PROJECTS) {
    await store.put(SCOPE, project, { files: { "agent.ts": "// v0" }, updatedAt: 0 }, null);
  }

  // A virtual clock: a job whose deploy THREW is left unacked on purpose and
  // stays invisible for the visibility timeout. Real time cannot reach past
  // that inside a test, so quiescing below advances this instead.
  let clock = 1;
  const queue = createMemoryPreviewQueue({ now: () => clock });

  const inFlight = new Map<string, number>();
  let quiescing = false;
  const deployWorkspace = async (_scope: string, project: string): Promise<unknown> => {
    const depth = (inFlight.get(project) ?? 0) + 1;
    inFlight.set(project, depth);
    if (depth > 1) problems.push(`seed ${seed}: ${depth} concurrent deploys of ${project}`);
    try {
      await jitter(rand);
      // Quiescing deploys always succeed, so the convergence check below is
      // about lost work rather than about the last roll of the dice.
      const roll = quiescing ? 1 : rand();
      if (roll < 0.15) throw new Error("sandbox died mid-deploy");
      if (roll < 0.3) return { ok: false, output: "build error: missing ;" };
      return { ok: true, slug: `${project}-preview` };
    } finally {
      inFlight.set(project, (inFlight.get(project) ?? 1) - 1);
    }
  };

  const deployer = createPreviewDeployer({
    workspaces: store,
    deployWorkspace: deployWorkspace as never,
    queue,
    // The timer is off: the interleaving drives `drainOnce` itself, so a seed
    // replays identically instead of depending on wall-clock timing.
    pollMs: 0,
  });

  const pending: Promise<unknown>[] = [];
  const edited = new Set<string>();
  for (let op = 0; op < 40; op += 1) {
    const roll = rand();
    const project = PROJECTS[Math.floor(rand() * PROJECTS.length)] as string;
    if (roll < 0.45) {
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
    } else if (roll < 0.85) {
      pending.push(deployer.drainOnce());
    } else {
      await jitter(rand);
    }
  }
  await Promise.all(pending);

  // Quiesce: step past each visibility window so redelivered jobs come back,
  // and drain until there is nothing left to run.
  quiescing = true;
  for (let round = 0; round < PREVIEW_JOB_MAX_ATTEMPTS + 4; round += 1) {
    clock += PREVIEW_JOB_VISIBILITY_MS + 1;
    await deployer.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  deployer.dispose();

  problems.push(...(await checkPreviewOutcome(seed, store, queue, edited)));
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
  seed: number,
  store: ReturnType<typeof createMemoryWorkspaceStore>,
  queue: ReturnType<typeof createMemoryPreviewQueue>,
  edited: Set<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const project of edited) {
    const workspace = await getWorkspace(store, SCOPE, project);
    if (!workspace) {
      problems.push(`seed ${seed}: ${project} vanished`);
      continue;
    }
    const settled =
      Boolean(workspace.previewError) || queue.archived.some((job) => job.job.project === project);
    if (workspace.previewHash !== currentFilesHash(workspace) && !settled) {
      problems.push(
        `seed ${seed}: ${project} never converged — stamped ${String(workspace.previewHash).slice(0, 8)}, files ${currentFilesHash(workspace).slice(0, 8)}`,
      );
    }
  }
  for (const job of queue.archived) {
    if (job.attempts <= PREVIEW_JOB_MAX_ATTEMPTS) {
      problems.push(`seed ${seed}: archived after only ${job.attempts} attempts`);
    }
  }
  return problems;
}

test("preview queue: every interleaving converges, one deploy per project at a time", async () => {
  const problems: string[] = [];
  for (let seed = 1; seed <= 200; seed += 1) problems.push(...(await fuzzPreviewPipeline(seed)));
  expect(problems.slice(0, 5)).toEqual([]);
}, 60_000);

beforeEach(() => resetLiveStreams());
afterEach(() => resetLiveStreams());

/**
 * One interleaving of an event stream's life: bursts of pushes whose producers
 * settle out of order, a client disconnect, a vanished row, and a shutdown
 * drain — in every order the seed happens to pick.
 */
async function fuzzSsePusher(seed: number): Promise<string[]> {
  const rand = seeded(seed);
  const problems: string[] = [];
  const written: string[] = [];
  let ended = false;
  let writesAfterEnd = 0;
  let onAbort = (): void => undefined;
  const stream = {
    writeSSE: async (frame: { event?: string; data: string }) => {
      // Checked on both sides of the await: a write must not be STARTED after
      // the stream ended, and the response may close while one is in flight.
      if (ended) writesAfterEnd += 1;
      await jitter(rand);
      written.push(`${frame.event}:${frame.data}`);
    },
    onAbort: (callback: () => void) => {
      onAbort = callback;
    },
  } as unknown as SSEStreamingApi;

  const sse = createSsePusher(stream);
  let cleanups = 0;
  const held = sse.wait(() => {
    cleanups += 1;
  });
  // Mark the end at the instant it happens, not when the cleanup callback
  // later runs — a write started in between is a write into a closing response.
  const endNow = (end: () => void): void => {
    ended = true;
    end();
  };

  const queued: string[] = [];
  for (let op = 0; op < 20; op += 1) {
    const roll = rand();
    if (roll < 0.62) {
      queued.push(`project:${op}`);
      sse.push(async () => {
        await jitter(rand);
        return { event: "project", data: String(op) };
      });
    } else if (roll < 0.72) {
      // The watched row vanished (project deleted) — ends the stream.
      sse.push(async () => {
        ended = true;
        return null;
      });
    } else if (roll < 0.82) {
      endNow(onAbort); // client disconnected
    } else if (roll < 0.9) {
      endNow(endLiveStreams); // replica scale-in
    }
  }

  await held;
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (cleanups !== 1) problems.push(`seed ${seed}: cleanup ran ${cleanups} times`);
  if (writesAfterEnd > 0) {
    problems.push(`seed ${seed}: ${writesAfterEnd} writes into an ended stream`);
  }
  if (liveStreamCount() !== 0) problems.push(`seed ${seed}: leaked a live-stream ender`);
  // Delivered frames must be an in-order subsequence of what was pushed:
  // producers settle out of order, the chain does not.
  const positions = written
    .filter((frame) => frame.startsWith("project:"))
    .map((frame) => queued.indexOf(frame));
  for (let i = 1; i < positions.length; i += 1) {
    if ((positions[i] as number) <= (positions[i - 1] as number)) {
      problems.push(`seed ${seed}: frames out of order — ${written.join(", ")}`);
      break;
    }
  }
  return problems;
}

test("SSE pusher: no write survives the stream's end, and frames stay ordered", async () => {
  const problems: string[] = [];
  for (let seed = 1; seed <= 400; seed += 1) {
    resetLiveStreams();
    problems.push(...(await fuzzSsePusher(seed)));
  }
  expect(problems.slice(0, 5)).toEqual([]);
}, 60_000);

/**
 * The live-stream registry under arbitrary register/unregister/shutdown
 * interleavings. It is process-global and latches closed, so the two things
 * that can go wrong are a stale ender surviving its response and a stream
 * registered after the drain never being ended at all — the second is the
 * MODAL case, since the client's reconnect backoff is shorter than the
 * shutdown grace period.
 */
/** Register a stream whose ends are counted; returns its deregistration. */
function registerCounting(counts: Map<number, number>, id: number, extra?: () => void): () => void {
  return registerLiveStream(() => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    extra?.();
  });
}

/** One interleaving of registrations, deregistrations, and shutdown drains. */
function fuzzLiveStreamRegistry(seed: number): string[] {
  const problems: string[] = [];
  const rand = seeded(seed);
  const endCounts = new Map<number, number>();
  const open: (() => void)[] = [];
  let next = 0;
  let drained = false;

  for (let op = 0; op < 30; op += 1) {
    const roll = rand();
    if (roll < 0.5) {
      open.push(registerCounting(endCounts, next++));
    } else if (roll < 0.8 && open.length > 0) {
      open.splice(Math.floor(rand() * open.length), 1)[0]?.();
    } else {
      endLiveStreams();
      drained = true;
    }
  }

  // Once drained, the registry latches closed — a stream opened afterwards
  // must end ITSELF rather than wait for a drain that already happened. Not
  // the rare case: the client's reconnect backoff is shorter than the
  // shutdown grace period, so a resubscribe landing here is the modal one.
  if (drained) {
    let endedImmediately = false;
    registerCounting(new Map(), -1, () => {
      endedImmediately = true;
    });
    if (!endedImmediately) {
      problems.push(`seed ${seed}: a stream opened during shutdown was never ended`);
    }
  }
  for (const [id, count] of endCounts) {
    if (count > 1) problems.push(`seed ${seed}: stream ${id} ended ${count} times`);
  }
  for (const unregister of open) unregister();
  if (liveStreamCount() !== 0) problems.push(`seed ${seed}: leaked ${liveStreamCount()}`);
  return problems;
}

test("live-stream registry: end-once, self-end after shutdown, never leak", () => {
  const problems: string[] = [];
  for (let seed = 1; seed <= 400; seed += 1) {
    resetLiveStreams();
    problems.push(...fuzzLiveStreamRegistry(seed));
  }
  expect(problems.slice(0, 5)).toEqual([]);
});
