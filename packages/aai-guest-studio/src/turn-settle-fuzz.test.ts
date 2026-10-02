// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleavings of one turn's workspace syncs: the mid-turn
 * checkpoints (`createWorkspaceCheckpointer`) racing each other and the
 * end-of-turn `settleTurn`, with walks and host replies released in an order
 * `fc.scheduler` picks — and shrinks. `turn-settle.test.ts` pins the shapes of
 * single calls; this covers the orderings between them.
 *
 * The host is faked at the RPC seam (`setHostSend`), applying each
 * `studio/sync-workspace` frame in the order the guest SENT it — last writer
 * wins, as `studio-session-wire.ts` does — or rejecting it. The tree is a
 * version counter; an edit bumps it and fires a checkpoint, exactly as a
 * mutating step's `onStepFinish` does. Settle runs after the last edit, as
 * `onFinish` does.
 *
 * The invariants:
 *
 * - **Checkpoint walks never overlap.** Two concurrent walks can interleave
 *   into a torn tree (the module's own reason for the coalescing runner).
 * - **Each failed checkpoint run is logged exactly once** — the `reported`
 *   latch exists so coalesced triggers do not log one failure N times, and it
 *   must not swallow a failure either.
 * - **The TURN-COMPLETE sync carries the final tree**, and **nothing the host
 *   applies after it moves the tree off that version**: `done: true` is what
 *   the host keys the preview deploy off, so a stale mid-turn checkpoint landing
 *   after it would leave the stored workspace (and the preview built from it)
 *   behind the turn that just finished. This one FAILED when the suite was
 *   written: `settleTurn` walked the tree without waiting for an in-flight
 *   checkpoint, so a checkpoint walk begun before the final edit could send
 *   its stale tree after the `done: true` sync. The settle now drains the
 *   checkpointer first; the shrunk ordering is the regression test below.
 * - **The settle never walks alongside a checkpoint** — the fix, stated.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { handleHostResponse, rejectAllPendingHostRequests, setHostSend } from "aai-guest-core/rpc";
import { installFakeHostChannel } from "aai-guest-core/test-utils";
import type { StudioSession } from "aai-guest-core/types";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { createWorkspaceCheckpointer, settleTurn } from "./turn-settle.ts";

const session: StudioSession = {
  scope: "s",
  project: "p",
  files: {},
  apiKey: "k",
  chatToken: "tok",
  system: "sys",
  model: "fake-1",
  maxSteps: 4,
  maxOutputTokens: 32_000,
  dir: "/workspace",
};

/** One event in a turn, before it settles. */
type Op = "edit" | "advance";

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant("edit" as const) },
  { weight: 2, arbitrary: fc.constant("advance" as const) },
);

/** Generated outcomes, consumed cyclically: walks may throw, the host may refuse. */
type Faults = { walkFails: readonly boolean[]; hostRefuses: readonly boolean[] };

const faultsArb: fc.Arbitrary<Faults> = fc.record({
  walkFails: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }).map((xs) => [...xs, false]),
  hostRefuses: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }).map((xs) => [...xs, false]),
});

/**
 * States the walk must reach — see `.agents/testing.md`: an all-green property
 * proves nothing about a state the generator never entered.
 */
const reached = { coalesced: 0, failedRuns: 0, settledMidCheckpoint: 0 };

/** One walk's state: the tree, the fakes' bookkeeping, and what the host applied. */
type World = {
  s: fc.Scheduler;
  faults: Faults;
  problems: string[];
  version: number;
  walkIndex: number;
  replyIndex: number;
  checkpointWalks: number;
  settleWalking: boolean;
  failedCheckpointRuns: number;
  /** What the host has applied, in the order it applied it. */
  applied: { version: number; done: boolean }[];
};

/** Note a walk starting, and flag any walk it overlaps. */
function enterWalk(world: World, kind: "checkpoint" | "settle"): void {
  if (kind === "checkpoint") {
    world.checkpointWalks += 1;
    if (world.checkpointWalks > 1) world.problems.push("two checkpoint walks overlapped");
    if (world.settleWalking) world.problems.push("a checkpoint walked while the settle did");
  } else {
    world.settleWalking = true;
    if (world.checkpointWalks > 0) world.problems.push("the settle walked while a checkpoint did");
  }
}

/** The `snapshotWorkspace` seam: reads the tree as of its START, ends when scheduled. */
async function walk(world: World, kind: "checkpoint" | "settle") {
  const seen = world.version;
  const fails = world.faults.walkFails[world.walkIndex++ % world.faults.walkFails.length] === true;
  enterWalk(world, kind);
  try {
    await world.s.schedule(Promise.resolve(), `${kind} walk v${seen}`);
    if (fails && kind === "checkpoint") {
      world.failedCheckpointRuns += 1;
      throw new Error("tree vanished");
    }
    return { files: { "agent.ts": `v${seen}` }, warnings: [] };
  } finally {
    if (kind === "checkpoint") world.checkpointWalks -= 1;
    else world.settleWalking = false;
  }
}

/** The host: applies each sync in SEND order (or refuses it), replies when scheduled. */
function installHost(world: World): void {
  setHostSend((msg) => {
    if (!("method" in msg && "id" in msg)) return;
    const { id, method } = msg;
    const params = (msg.params ?? {}) as { files?: Record<string, string>; done?: boolean };
    const { hostRefuses } = world.faults;
    const refuses = hostRefuses[world.replyIndex++ % hostRefuses.length] === true;
    if (method === "studio/sync-workspace") {
      const done = params.done === true;
      const version = Number(String(params.files?.["agent.ts"]).slice(1));
      if (!refuses) world.applied.push({ version, done });
      else if (!done) world.failedCheckpointRuns += 1;
    }
    void world.s.schedule(Promise.resolve(), `reply ${method} #${id}`).then(() => {
      handleHostResponse(
        refuses ? { id, error: { code: -32_000, message: "host refused" } } : { id, result: {} },
      );
    });
  });
}

/** TURN-COMPLETE carries the final tree, and nothing applied after it moves the tree. */
function checkApplied(world: World): void {
  const doneAt = world.applied.findIndex((entry) => entry.done);
  if (doneAt < 0) return;
  for (const entry of world.applied.slice(doneAt)) {
    if (entry.version === world.version) continue;
    world.problems.push(
      entry.done
        ? `TURN-COMPLETE sync carried v${entry.version}, the turn ended at v${world.version}`
        : `a v${entry.version} sync landed after the TURN-COMPLETE v${world.version} one`,
    );
  }
}

async function runTurnSyncs(
  s: fc.Scheduler,
  ops: readonly Op[],
  faults: Faults,
): Promise<string[]> {
  const world: World = {
    s,
    faults,
    problems: [],
    version: 0,
    walkIndex: 0,
    replyIndex: 0,
    checkpointWalks: 0,
    settleWalking: false,
    failedCheckpointRuns: 0,
    applied: [],
  };
  installHost(world);
  const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
  try {
    const checkpoint = createWorkspaceCheckpointer(session, () => walk(world, "checkpoint"));
    for (const op of ops) {
      if (op === "edit") {
        world.version += 1;
        if (world.checkpointWalks > 0) reached.coalesced += 1;
        checkpoint();
      } else if (s.count() > 0) {
        await s.waitNext(1);
      }
      // A step boundary: the runner starts its walk a microtask after the
      // trigger, and a model step is never synchronous with the one before.
      await sleep(0);
    }
    // `onFinish`: the turn is over, nothing edits the tree from here on.
    // A refused settle is logged by `chat.ts`'s caller, not here — handled at
    // once so a rejection before the drain below is not reported as unhandled.
    if (world.checkpointWalks > 0) reached.settledMidCheckpoint += 1;
    const settled = settleTurn(session, [], () => walk(world, "settle"), checkpoint).catch(
      () => undefined,
    );
    // The settle drains every checkpoint first, so waiting for it (releasing
    // tasks as it needs them) drains the whole turn.
    await s.waitFor(settled);

    const logged = errors.mock.calls.filter(([line]) =>
      String(line).includes("workspace checkpoint failed"),
    ).length;
    reached.failedRuns += world.failedCheckpointRuns;
    if (logged !== world.failedCheckpointRuns) {
      world.problems.push(
        `${world.failedCheckpointRuns} checkpoint run(s) failed but ${logged} were logged`,
      );
    }
    checkApplied(world);
  } finally {
    errors.mockRestore();
    rejectAllPendingHostRequests("teardown");
    setHostSend(null);
  }
  return world.problems;
}

test("checkpoints and the settle: serialized walks, one log per failure, TURN-COMPLETE is the last word", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(opArb, { minLength: 1, maxLength: 24 }),
      faultsArb,
      async (s, ops, faults) => {
        expect(await runTurnSyncs(s, ops, faults)).toEqual([]);
      },
    ),
    { numRuns: 80 },
  );

  // Coverage floors, each under the minimum observed by
  // `pnpm floors:sample --runs 20` (range beside each).
  expect(reached.coalesced, "no edit ever landed while a checkpoint walked").toBeGreaterThan(50); // Measured over 20 runs: 108-192.
  expect(reached.failedRuns, "no checkpoint run ever failed").toBeGreaterThan(60); // Measured over 20 runs: 119-149.
  expect(reached.settledMidCheckpoint, "the turn never ended mid-checkpoint").toBeGreaterThan(20); // Measured over 20 runs: 43-54.
});

/**
 * The property's shrunk counterexample, pinned: edit → a checkpoint walk of v1
 * starts; edit → a trailing checkpoint queues behind it; the turn ends and the
 * settle walks v2 — which, before the fix, finished FIRST, so the host applied
 * `v2 done`, then the stale `v1`, then `v2` again.
 */
test("regression: a checkpoint begun before the final edit never lands after TURN-COMPLETE", async () => {
  const channel = installFakeHostChannel({ autoAnswer: true });
  try {
    let version = 1;
    const held: (() => void)[] = [];
    const checkpoint = createWorkspaceCheckpointer(session, () => {
      const seen = version;
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push(resolve);
      return promise.then(() => ({ files: { "agent.ts": `v${seen}` }, warnings: [] }));
    });
    checkpoint();
    await sleep(0); // the v1 walk is in flight
    version = 2;
    checkpoint(); // coalesces into one trailing run
    let finished = false;
    const settled = settleTurn(
      session,
      [],
      async () => ({ files: { "agent.ts": `v${version}` }, warnings: [] }),
      checkpoint,
    ).then(() => {
      finished = true;
    });
    for (let round = 0; round < 20 && !finished; round += 1) {
      held.shift()?.();
      await sleep(0);
    }
    await settled;

    const syncs = channel.sent.flatMap((msg) =>
      "method" in msg && msg.method === "studio/sync-workspace"
        ? [msg.params as { files: Record<string, string>; done?: boolean }]
        : [],
    );
    expect(syncs.map((sync) => `${sync.files["agent.ts"]}${sync.done ? " done" : ""}`)).toEqual([
      "v1",
      "v2",
      "v2 done",
    ]);
  } finally {
    setHostSend(null);
  }
});
