// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleavings of `ensureWorkspaceDependencies` callers on ONE
 * workspace — a build, a Publish and a session-init all reifying the same
 * manifest — with each `npm install` finishing (fully, partly, or not at all)
 * when `fc.scheduler` says. `workspace-deps.test.ts` pins single calls; this
 * covers the orderings between them. The workspace is a real temp directory
 * (presence on disk IS the module's notion of "installed"); npm is the
 * `runNpm` seam, landing packages with `mkdir` as a real install would.
 *
 * The invariants:
 *
 * - **npm never runs twice at once in one directory** — npm takes no lock of
 *   its own (the per-directory lock's reason).
 * - **npm never runs when nothing is missing** — a caller that waited on the
 *   lock while another installed exactly these re-checks inside it.
 * - **A caller's verdict matches the disk**: `null` iff every declared
 *   package resolves when it answers, and a warning names what does not.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import { useTempDirs } from "aai-guest-core/test-utils";
import fc from "fast-check";
import { expect, test } from "vitest";
import { npmResult } from "./_test-utils.ts";
import { ensureWorkspaceDependencies } from "./workspace-deps.ts";

const DECLARED = ["left-pad", "ms"] as const;

/** How one npm run ends: every package lands, only the first, or none. */
type Install = "all" | "partial" | "none";

/** What each outcome puts on disk. */
const LANDS: Record<Install, readonly string[]> = {
  all: DECLARED,
  partial: DECLARED.slice(0, 1),
  none: [],
};

const installArb: fc.Arbitrary<Install> = fc.constantFrom("all", "partial", "none");

type Op = { kind: "call" } | { kind: "advance" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: "call" } as const) },
  { weight: 3, arbitrary: fc.constant({ kind: "advance" } as const) },
);

/** States the walk must reach — floors asserted after the property. */
const reached = { npmRuns: 0, calledDuringInstall: 0, warned: 0 };

const tempDir = useTempDirs("aai-deps-fuzz-");

/** What is wrong with a caller's verdict, given what is still missing as it answers. */
function judgeVerdict(warning: string | null, stillMissing: readonly string[]): string[] {
  if (warning === null) {
    return stillMissing.length === 0 ? [] : [`null verdict with ${stillMissing} missing`];
  }
  reached.warned += 1;
  if (stillMissing.length === 0) return ["a warning with nothing missing"];
  return stillMissing.filter((name) => !warning.includes(name)).map((n) => `warning omits ${n}`);
}

async function runCallers(
  s: fc.Scheduler,
  ops: readonly Op[],
  installs: readonly Install[],
): Promise<string[]> {
  const problems: string[] = [];
  const dir = await tempDir();
  const dependencies = Object.fromEntries(DECLARED.map((name) => [name, "*"]));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies }), "utf-8");
  const present = (name: string) => existsSync(path.join(dir, "node_modules", name));
  const missing = () => DECLARED.filter((name) => !present(name));

  let running = 0;
  let runIndex = 0;
  const runNpm = async () => {
    reached.npmRuns += 1;
    running += 1;
    if (running > 1) problems.push("two npm installs ran in one directory");
    if (missing().length === 0) problems.push("npm ran with nothing missing");
    const outcome = installs[runIndex++ % installs.length] as Install;
    try {
      await s.schedule(Promise.resolve(), `npm #${runIndex} → ${outcome}`);
      const landing = LANDS[outcome];
      for (const name of landing) {
        await mkdir(path.join(dir, "node_modules", name), { recursive: true });
      }
      return npmResult({ stdout: `added ${landing.length} packages` });
    } finally {
      running -= 1;
    }
  };

  const pending: Promise<void>[] = [];
  for (const op of ops) {
    if (op.kind === "call") {
      if (running > 0) reached.calledDuringInstall += 1;
      pending.push(
        ensureWorkspaceDependencies(dir, { toolchainModules: null, runNpm }).then((warning) => {
          problems.push(...judgeVerdict(warning, missing()));
        }),
      );
    } else if (s.count() > 0) {
      await s.waitNext(1);
    }
    await sleep(0);
  }
  // `waitFor`, not `waitIdle` then `Promise.all`: a caller still reading the
  // manifest has not scheduled its npm run yet, and waiting on it without
  // releasing tasks would deadlock on the very run it is about to start.
  await s.waitFor(Promise.all(pending));
  return problems;
}

test("callers reifying one workspace: one npm at a time, none redundant, verdicts match the disk", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc
        .array(opArb, { minLength: 1, maxLength: 14 })
        .map((ops) => [{ kind: "call" } as const, ...ops]),
      fc.array(installArb, { minLength: 1, maxLength: 4 }),
      async (s, ops, installs) => {
        expect(await runCallers(s, ops, installs)).toEqual([]);
      },
    ),
    { numRuns: 40 },
  );

  // Coverage floors, each under the minimum observed by
  // `pnpm floors:sample --runs 20` (range beside each).
  expect(reached.npmRuns, "npm never ran").toBeGreaterThan(30); // Measured over 20 runs: 67-101.
  expect(reached.calledDuringInstall, "no caller ever met an install in flight").toBeGreaterThan(
    10,
  ); // Measured over 20 runs: 26-55.
  expect(reached.warned, "no install ever left a package missing").toBeGreaterThan(20); // Measured over 20 runs: 42-86.
});
