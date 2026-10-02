// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleavings of `studio/session-init` installs and chat turns on
 * one guest: page opens (a refresh, a second tab, a mis-routed replica naming
 * ANOTHER project) arriving while an install or a turn holds the workspace
 * claim. `fc.scheduler` decides when each install starts and when each turn
 * lets go of the claim; the installs themselves run against the real
 * filesystem, as `session-init.test.ts`'s do (the per-process session dir).
 *
 * The invariants:
 *
 * - **One sandbox, one project.** Every install that RESOLVED names the same
 *   (scope, project). `SessionIdentityError` exists so a mis-keyed registry
 *   row is a 409 rather than one tenant's workspace in another's sandbox. This
 *   FAILED when the suite was written: the pin was written only once the first
 *   install finished, so a session-init for a DIFFERENT project arriving
 *   DURING that install found no pin, could not take the claim, and was handed
 *   a session over the first project's tree. The in-flight install's identity
 *   now counts as the pin; the shrunk case is the regression test below.
 * - **The live tree wins.** Nothing a turn wrote while holding the claim is
 *   deleted before it lets go (an install's `rm -rf` must not run under it).
 * - **No claim leaks.** Once everything settles the claim is free.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import type { StudioSession, StudioSessionParams } from "aai-guest-core/types";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { initStudioSession, resetSessionIdentity, SessionIdentityError } from "./session.ts";
import { enterTurn, resetTurnGate } from "./turn-stream.ts";

const PROJECTS = ["proj-a", "proj-b"] as const;

const params = (project: string, stamp: number): StudioSessionParams => ({
  scope: "scope",
  project,
  files: { "agent.ts": `// ${project} ${stamp}` },
  apiKey: "caller-key",
  chatToken: `token-${stamp}`,
  system: "You are a coding agent.",
  model: "fake-1",
  maxSteps: 4,
  maxOutputTokens: 32_000,
});

/** One event on the guest. `project` indexes {@link PROJECTS}. */
type Op = { kind: "init"; project: number } | { kind: "turn" } | { kind: "advance" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("init" as const),
      project: fc.nat({ max: PROJECTS.length - 1 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "turn" } as const) },
  { weight: 3, arbitrary: fc.constant({ kind: "advance" } as const) },
);

/** States the walk must reach — floors asserted after the property. */
const reached = { keptLiveTree: 0, identityRefused: 0, turnRefused: 0 };

/** One walk's state, shared by the op handlers below. */
type Guest = {
  s: fc.Scheduler;
  problems: string[];
  resolved: StudioSession[];
  pending: Promise<unknown>[];
  stamp: number;
};

/** A page open: a session-init that starts when the scheduler says. */
function startInit(guest: Guest, project: string): void {
  const asked = params(project, ++guest.stamp);
  guest.pending.push(
    guest.s
      .schedule(Promise.resolve(), `init ${project} #${guest.stamp}`)
      .then(() => initStudioSession(asked))
      .then(
        (session) => {
          guest.resolved.push(session);
        },
        (err: unknown) => {
          if (err instanceof SessionIdentityError) reached.identityRefused += 1;
          else guest.problems.push(`install failed: ${String(err)}`);
        },
      ),
  );
}

/** A turn: take the claim, edit the live tree, hold it until the scheduler says. */
async function startTurn(guest: Guest): Promise<void> {
  // A turn needs an installed session to run against.
  const session = guest.resolved.at(-1);
  if (!session) return;
  const release = enterTurn();
  if (!release) {
    reached.turnRefused += 1;
    return;
  }
  const marker = path.join(session.dir, `turn-${++guest.stamp}.txt`);
  await writeFile(marker, "mid-turn edit", "utf-8");
  guest.pending.push(
    guest.s.schedule(Promise.resolve(), `turn ends #${guest.stamp}`).then(() => {
      if (!existsSync(marker)) guest.problems.push("an install reset the tree under a turn");
      release();
    }),
  );
}

async function runGuest(
  s: fc.Scheduler,
  ops: readonly Op[],
  preinstalled: boolean,
): Promise<string[]> {
  const guest: Guest = { s, problems: [], resolved: [], pending: [], stamp: 0 };
  resetSessionIdentity();
  resetTurnGate();
  const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
  try {
    // Half the walks open on a guest that already serves proj-a, which is the
    // state turns run in; the other half start cold, which is the only state
    // the FIRST install's window exists in.
    if (preinstalled) {
      guest.resolved.push(await initStudioSession(params(PROJECTS[0], ++guest.stamp)));
    }
    for (const op of ops) {
      if (op.kind === "init") startInit(guest, PROJECTS[op.project] as string);
      else if (op.kind === "turn") await startTurn(guest);
      else if (s.count() > 0) await s.waitNext(1);
      await sleep(0);
    }
    await s.waitFor(Promise.all(guest.pending));

    reached.keptLiveTree += errors.mock.calls.filter(([line]) =>
      String(line).includes("keeping the live workspace"),
    ).length;
    const identities = new Set(guest.resolved.map((one) => `${one.scope}/${one.project}`));
    if (identities.size > 1) {
      guest.problems.push(`one sandbox handed out sessions for ${[...identities].join(" AND ")}`);
    }
    const free = enterTurn();
    if (!free) guest.problems.push("the workspace claim leaked");
    free?.();
  } finally {
    errors.mockRestore();
    resetTurnGate();
    resetSessionIdentity();
  }
  return guest.problems;
}

test("session installs vs turns: one project per sandbox, the live tree wins, no leaked claim", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      fc.boolean(),
      async (s, ops, preinstalled) => {
        expect(await runGuest(s, ops, preinstalled)).toEqual([]);
      },
    ),
    { numRuns: 30 },
  );

  // Coverage floors, each under the minimum observed by
  // `pnpm floors:sample --runs 20` (range beside each).
  expect(reached.keptLiveTree, "no session-init ever met a held claim").toBeGreaterThan(3); // Measured over 20 runs: 8-28.
  expect(reached.identityRefused, "no other project's install was ever refused").toBeGreaterThan(3); // Measured over 20 runs: 8-46.
  expect(reached.turnRefused, "no turn ever met a held claim").toBeGreaterThan(0); // Measured over 20 runs: 3-26.
});

/**
 * The property's shrunk counterexample, pinned: an install for proj-b starts,
 * and a session-init for proj-a arrives before it finishes. Before the fix
 * proj-a found no pin, could not take the claim, and RESOLVED — a session for
 * one project over the tree being materialized for another.
 */
test("regression: a session-init for another project during the first install is refused", async () => {
  resetSessionIdentity();
  resetTurnGate();
  const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
  try {
    const first = initStudioSession(params("proj-b", 1));
    await expect(initStudioSession(params("proj-a", 2))).rejects.toBeInstanceOf(
      SessionIdentityError,
    );
    await expect(first).resolves.toMatchObject({ project: "proj-b" });
  } finally {
    errors.mockRestore();
    resetTurnGate();
    resetSessionIdentity();
  }
});
