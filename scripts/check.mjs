// Copyright 2026 the AAI authors. MIT license.
/**
 * The repo's check pipeline, as a TABLE plus one runner.
 *
 * Usage:
 *   node scripts/check.mjs                  # full CI check        (pnpm check)
 *   node scripts/check.mjs --local          # fast pre-push gate   (pnpm check:local)
 *   node scripts/check.mjs --fix            # every auto-fixer     (pnpm fix)
 *   node scripts/check.mjs --gates ci       # one phase set, nothing else (CI)
 *   node scripts/check.mjs --turbo ci       # one turbo task set, nothing else (CI)
 *   node scripts/check.mjs --list-gates     # the table as JSON, for a reader
 *   node scripts/check.mjs --catalogue print|write|check
 *                                           # the gate table in .agents/ratchets.md
 *
 * ## What a row means
 *
 * `phase` says WHEN a gate runs. Ordering within a phase is SOURCE ORDER, which
 * is load-bearing for the after-build api-report -> api-contracts ->
 * authoring-guide chain (each reads what the one before it wrote), so that
 * phase runs serially. The `ratchets` phase is pure git/fs reads with no
 * ordering between rows, so it runs in PARALLEL with buffered output, printed
 * back in table order ({@link PARALLEL_PHASES}).
 *
 * `fatal: true` stops the run. `fatal: false` records the failure, keeps going,
 * and fails the process at the very end, so a branch that trips three ratchets
 * is told about all three in one run. {@link record} is the only reader of it.
 *
 * `fix` names the root script that repairs a failure mechanically — a `sync:*`
 * copy, a regenerated report, or a lower-only baseline `--update`. A failing
 * gate prints it, and `--fix` runs every one in table order.
 *
 * `mode` narrows a row to one mode; absent means both.
 *
 * Why each gate exists is in `.agents/ratchets.md`, beside the catalogue
 * `--catalogue write` generates from this table (`check:gate-catalogue`).
 *
 * ## This table is the ONLY list, and CI reads it
 *
 * CI runs `--gates ci` and `--turbo ci` rather than restating either list, so
 * adding, renaming or deleting a gate or a turbo task is an edit here alone. A
 * restated copy is what drifted before: a deleted gate left its `pnpm run` line
 * in the workflow, failing every push while `pnpm check` stayed green.
 * `packages/aai-gates/src/gate-wiring.test.ts` reads this table and the
 * workflow independently, from a package owning neither.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { parseScriptArgs, USAGE_EXIT } from "./_args.mjs";
import { LATER_TURBO, TURBO_SELECTIONS, TURBO_TASKS } from "./_check-turbo-tasks.mjs";
import { readJson, repoRoot } from "./_fs.mjs";
import { boundTurboConcurrency, gateConcurrency } from "./_turbo-concurrency.mjs";

const ROOT = repoRoot(import.meta.url);

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    local: { type: "boolean" },
    fix: { type: "boolean" },
    gates: { type: "string" },
    turbo: { type: "string" },
    "list-gates": { type: "boolean" },
    catalogue: { type: "string" },
  },
});
const MODE = FLAGS.local === true ? "local" : "full";

/**
 * Whether to speak GitHub's workflow-command dialect: only `::error`, so a
 * failing gate becomes an ANNOTATION naming it. No `::group` — `check:konsistent`
 * emits its own `::error` lines when this is set.
 */
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

// Spelled as escapes, never as the raw bytes: one control character makes a
// whole file BINARY to `git grep`, exempting it from every line rule.
const GREEN = "\u001b[0;32m";
const RED = "\u001b[0;31m";
const YELLOW = "\u001b[1;33m";
const DIM = "\u001b[2m";
const NC = "\u001b[0m";

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Gate
 * @property {string} script The `package.json` script name, spelled out.
 * @property {"ratchets" | "after-tests" | "after-build"} phase When it runs.
 * @property {boolean} fatal Stop the run, or record it and carry on.
 * @property {string} [fix] The root script that repairs a failure mechanically.
 * @property {"local" | "full"} [mode] Restrict to one mode; absent means both.
 */

/** @type {Gate[]} */
const GATES = [
  // --- ratchets ----------------------------------------------------------
  // Fast, pure git/fs gates holding the line on technical debt. Up front, so a
  // debt regression fails before the slow turbo tasks; parallel; non-fatal.
  { script: "check:hatches", phase: "ratchets", fatal: false, fix: "hatches:update" },
  { script: "check:invariants", phase: "ratchets", fatal: false, fix: "invariants:update" },
  { script: "check:file-length", phase: "ratchets", fatal: false, fix: "file-length:update" },
  { script: "check:duplication", phase: "ratchets", fatal: false, fix: "duplication:update" },
  { script: "check:guest-contract", phase: "ratchets", fatal: false },
  { script: "check:package-layout", phase: "ratchets", fatal: false },
  { script: "check:test-assertions", phase: "ratchets", fatal: false },
  {
    script: "check:property-floors",
    phase: "ratchets",
    fatal: false,
    fix: "property-floors:update",
  },
  { script: "check:module-tests", phase: "ratchets", fatal: false, fix: "module-tests:update" },
  { script: "check:claude-md", phase: "ratchets", fatal: false, fix: "claude-md:update" },
  { script: "check:guide-index", phase: "ratchets", fatal: false, fix: "sync:guide-index" },
  {
    script: "check:gate-catalogue",
    phase: "ratchets",
    fatal: false,
    fix: "sync:gate-catalogue",
  },
  {
    script: "check:guest-toolchain",
    phase: "ratchets",
    fatal: false,
    fix: "sync:guest-toolchain",
  },
  { script: "check:agent-guide", phase: "ratchets", fatal: false, fix: "sync:agent-guide" },
  {
    script: "check:provider-table",
    phase: "ratchets",
    fatal: false,
    fix: "sync:provider-table",
  },
  { script: "check:studio-prompt", phase: "ratchets", fatal: false, fix: "sync:studio-prompt" },
  { script: "check:scaffold", phase: "ratchets", fatal: false, fix: "sync:scaffold" },
  { script: "check:defaults", phase: "ratchets", fatal: false },
  { script: "check:konsistent", phase: "ratchets", fatal: false },
  { script: "check:deploy-changeset", phase: "ratchets", fatal: false },
  { script: "check:migration-order", phase: "ratchets", fatal: false },
  { script: "check:optional-peers", phase: "ratchets", fatal: false },
  { script: "check:untyped-imports", phase: "ratchets", fatal: false },

  // --- after the test run ------------------------------------------------
  // Reads what test:coverage wrote; a turbo cache hit restores `coverage/**`.
  { script: "check:coverage-per-file", phase: "after-tests", fatal: false },

  // --- after the build ---------------------------------------------------
  // These read `dist/`, or PACK, so they cannot run before the turbo phase.
  // ORDER IS LOAD-BEARING from check:api-report down: each reads what the one
  // before it wrote, and a stale artifact would be believed.
  { script: "check:publish-names", phase: "after-build", fatal: true },
  { script: "check:publish-protocols", phase: "after-build", fatal: true },
  { script: "check:api-report", phase: "after-build", fatal: true, fix: "api-report" },
  { script: "check:api-nameable", phase: "after-build", fatal: true, fix: "api-nameable:update" },
  { script: "check:bundled-deps", phase: "after-build", fatal: false, fix: "bundled-deps:update" },
  { script: "check:api-contracts", phase: "after-build", fatal: true },
  { script: "check:authoring-guide", phase: "after-build", fatal: true },
  { script: "check:docs-md", phase: "after-build", fatal: true, fix: "docs:md" },
  { script: "check:template-types", phase: "after-build", fatal: true },
  { script: "check:doc-examples", phase: "after-build", fatal: true },
];

/**
 * Phase sets a caller may ask for by NAME, so CI names a JOB rather than a list.
 *
 * `ci` is the `lint-typecheck-and-checks` job: the ratchets (no build) and the
 * after-build gates (that job restores every package's `dist` first). The
 * `after-tests` phase belongs to the coverage matrix, which invokes the gate per
 * package with `--package`. `--gates <phase>` still takes phases directly.
 */
const GATE_SELECTIONS = {
  ci: ["ratchets", "after-build"],
};

/** Phases whose rows may run concurrently: no row reads what another writes. */
const PARALLEL_PHASES = new Set(["ratchets"]);

/** Every turbo task a call in `mode` runs, first call and later ones. */
const turboTasksOf = (mode) => [...TURBO_TASKS[mode], ...LATER_TURBO[mode].map((c) => c.task)];

// Full mode must be a strict SUPERSET of local, or a green `pnpm check` could
// still fail `pnpm check:local` — refuse to run with the tables disagreeing.
const missingFromFull = turboTasksOf("local").filter((t) => !turboTasksOf("full").includes(t));
if (missingFromFull.length > 0) {
  console.error(`check: full mode does not run ${missingFromFull.join(", ")}, which local does.`);
  process.exit(USAGE_EXIT);
}

/**
 * What `--local` does NOT cover, COMPUTED from the tables and named out loud: a
 * green subset reads as a green branch, and the gates left out are the ones
 * whose failures are hardest to guess from a diff.
 */
const NOT_RUN_BY_LOCAL = [
  ...turboTasksOf("full").filter((t) => !turboTasksOf("local").includes(t)),
  ...GATES.filter((gate) => gate.mode === "full").map((gate) => gate.script),
];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Failures from every `fatal: false` gate, reported together at the end. */
const deferred = [];

/**
 * Run a command, inheriting stdio, and answer whether it succeeded. No shell:
 * every argument is a literal here, so there is no quoting rule to get wrong.
 */
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    console.error(`check: could not run ${command} — ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

/** Live children of a parallel phase, killed when a fatal gate ends the run. */
const children = new Set();

/**
 * Run one gate with its output BUFFERED (stdout and stderr interleaved in
 * arrival order), for a parallel phase to print back in table order.
 *
 * @returns {Promise<{ ok: boolean, output: string, ms: number }>}
 */
function runBuffered(gate) {
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn("pnpm", ["run", gate.script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    children.add(child);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const finish = (ok, extra = "") => {
      children.delete(child);
      const output = Buffer.concat(chunks).toString("utf8") + extra;
      resolve({ ok, output, ms: Date.now() - started });
    };
    child.on("error", (err) => finish(false, `check: could not run pnpm — ${err.message}\n`));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Record one gate's verdict. The single place `fatal` is interpreted: a fatal
 * failure exits immediately, the rest are collected for the end.
 */
function record(gate, ok) {
  if (ok) return;
  // The annotation puts the gate's NAME in front of a reader who has not
  // expanded the log.
  // A `:update` fixer only ever LOWERS a baseline, so it cannot clear growth.
  const fix =
    gate.fix === undefined
      ? ""
      : `pnpm ${gate.fix}${gate.fix.endsWith(":update") ? " (records an improvement; never raises a budget)" : ""}`;
  if (ANNOTATE) {
    console.log(
      `::error title=${gate.script}::${gate.script} failed${fix ? ` — fix: ${fix}` : ""}`,
    );
  }
  if (fix) console.error(`${YELLOW}  fix: ${fix}${NC}`);
  if (gate.fatal) {
    for (const child of children) child.kill("SIGTERM");
    console.error(`\n${RED}${gate.script} failed.${NC}`);
    process.exit(1);
  }
  deferred.push(gate);
}

/** Every gate in a phase that applies to this mode, in source order. */
const gatesFor = (phase) =>
  GATES.filter((gate) => gate.phase === phase && (gate.mode ?? MODE) === MODE);

/**
 * Run a phase's gates at most {@link gateConcurrency} at a time, printing each
 * one's buffered output in TABLE order as soon as it and every row before it
 * have finished — so the log reads exactly as a serial run would.
 */
async function runParallel(gates) {
  const limit = gateConcurrency();
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];
  // FIFO slots, so gates START in table order too.
  const acquire = () => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers();
    queue.push(() => resolve(undefined));
    return promise;
  };
  const release = () => {
    const waiter = queue.shift();
    if (waiter === undefined) active--;
    else waiter();
  };
  const results = gates.map(async (gate) => {
    await acquire();
    try {
      return await runBuffered(gate);
    } finally {
      release();
    }
  });
  for (const [i, gate] of gates.entries()) {
    const result = await /** @type {Promise<{ ok: boolean, output: string, ms: number }>} */ (
      results[i]
    );
    const mark = result.ok ? `${GREEN}ok${NC}` : `${RED}FAILED${NC}`;
    console.log(
      `\n${DIM}──${NC} ${gate.script} ${mark} ${DIM}(${(result.ms / 1000).toFixed(1)}s)${NC}`,
    );
    process.stdout.write(result.output);
    record(gate, result.ok);
  }
}

/** Run a phase: in parallel when {@link PARALLEL_PHASES} allows it, else serially. */
async function runPhase(phase) {
  const gates = gatesFor(phase);
  if (PARALLEL_PHASES.has(phase) && gates.length > 1) {
    await runParallel(gates);
    return;
  }
  for (const gate of gates) record(gate, run("pnpm", ["run", gate.script]));
}

/** The closing verdict over every deferred failure, naming the fixes. */
function reportDeferred() {
  if (deferred.length === 0) return;
  console.error(
    `\n${RED}Quality ratchet(s) failed: ${deferred.map((g) => g.script).join(", ")}${NC}`,
  );
  const fixes = [...new Set(deferred.flatMap((g) => (g.fix === undefined ? [] : [g.fix])))];
  if (fixes.length > 0) {
    console.error(
      `${YELLOW}Auto-fixable: pnpm fix (or ${fixes.map((f) => `pnpm ${f}`).join(", ")})${NC}`,
    );
  }
  process.exit(1);
}

/**
 * Run one selection — a {@link GATE_SELECTIONS} name or a comma list of phases
 * — and nothing else. Never returns. This is what `check.yml` invokes.
 *
 * A selection naming an undeclared phase, or resolving to ZERO gates, is a
 * USAGE error (exit 2): this function's whole output is a count, so an empty
 * run and a clean run would otherwise print the same checkmark.
 */
async function runSelection(selection) {
  const declared = new Set(GATES.map((gate) => gate.phase));
  const phases = GATE_SELECTIONS[selection] ?? selection.split(",").map((phase) => phase.trim());
  const unknown = phases.filter((phase) => !declared.has(phase));
  const usage = `Selections: ${Object.keys(GATE_SELECTIONS).join(", ")}. Phases: ${[...declared].join(", ")}.`;
  if (unknown.length > 0) {
    console.error(
      `check: --gates ${selection} names no such phase: ${unknown.join(", ")}. ${usage}`,
    );
    process.exit(USAGE_EXIT);
  }
  const chosen = phases.flatMap((phase) => gatesFor(phase));
  if (chosen.length === 0) {
    console.error(`check: --gates ${selection} selected NO gate in ${MODE} mode. ${usage}`);
    process.exit(USAGE_EXIT);
  }
  for (const phase of phases) await runPhase(phase);
  reportDeferred();
  console.log(`\n${GREEN}All ${chosen.length} gate(s) in --gates ${selection} passed.${NC}`);
  process.exit(0);
}

function turbo(args, env = {}) {
  if (run("pnpm", ["exec", "turbo", "run", ...args], env)) return;
  console.error(`\n${RED}Some checks failed.${NC}`);
  process.exit(1);
}

/**
 * `--turbo <name>`: one {@link TURBO_SELECTIONS} task set, `--continue`, and
 * nothing else — CI's lint job, derived from full mode's first call. Turbo's
 * own concurrency: no vitest pool runs in it, so the worker budget is moot.
 */
function runTurboSelection(name) {
  const tasks = TURBO_SELECTIONS[name];
  if (tasks === undefined || tasks.length === 0) {
    console.error(
      `check: --turbo ${name} is not one of ${Object.keys(TURBO_SELECTIONS).join(", ")}.`,
    );
    process.exit(USAGE_EXIT);
  }
  turbo([...tasks, "--continue"]);
  console.log(`\n${GREEN}All ${tasks.length} turbo task(s) in --turbo ${name} passed.${NC}`);
  process.exit(0);
}

/**
 * `--fix`: every auto-fixer, in TABLE order after `pnpm format` — the `sync:*`
 * copies, the regenerated reports, and the lower-only baseline `--update`s
 * (each refuses to raise a budget, so a real regression still fails here).
 * `pnpm build` (a turbo cache hit when nothing moved) goes in front of the
 * first fixer that reads `dist/`. Every step runs; failures are listed at the
 * end.
 */
function runFixes() {
  const manifest = /** @type {{ scripts?: Record<string, string> }} */ (
    readJson(`${ROOT}/package.json`)
  );
  const steps = ["format"];
  for (const gate of GATES) {
    if (gate.fix === undefined || steps.includes(gate.fix)) continue;
    if (gate.phase === "after-build" && !steps.includes("build")) steps.push("build");
    steps.push(gate.fix);
  }
  const failed = [];
  for (const step of steps) {
    if (manifest.scripts?.[step] === undefined) {
      failed.push(`${step} (not a root script)`);
      continue;
    }
    console.log(`\n${YELLOW}▶ pnpm ${step}${NC}`);
    if (!run("pnpm", ["run", step])) failed.push(step);
  }
  if (failed.length > 0) {
    console.error(`\n${RED}Fixers that did not succeed: ${failed.join(", ")}${NC}`);
    console.error(
      "A lower-only --update refuses to raise a budget: that failure is a real regression.",
    );
    process.exit(1);
  }
  console.log(`\n${GREEN}All ${steps.length} fixer(s) ran. Review the diff, then commit.${NC}`);
  process.exit(0);
}

// The TABLE as data, for anything that needs to know what this repo gates on
// without running it. Deliberately NOT what CI consumes: a shell loop over this
// JSON would re-decide `fatal` per row.
if (FLAGS["list-gates"] === true) {
  console.log(
    JSON.stringify(
      { selections: GATE_SELECTIONS, notRunByLocal: NOT_RUN_BY_LOCAL, gates: GATES },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (FLAGS.catalogue !== undefined) {
  const { runCatalogue } = await import("./_gate-catalogue.mjs");
  process.exit(await runCatalogue({ root: ROOT, gates: GATES, action: FLAGS.catalogue }));
}

if (FLAGS.fix === true) runFixes();
if (FLAGS.turbo !== undefined) runTurboSelection(FLAGS.turbo);

// Bound turbo's task concurrency, which sizes each task's vitest worker pool in
// turn (`scripts/_turbo-concurrency.mjs`). An explicit TURBO_CONCURRENCY wins.
boundTurboConcurrency();

if (FLAGS.gates !== undefined) await runSelection(FLAGS.gates);

await runPhase("ratchets");

const banner = MODE === "local" ? "Running local checks" : "Running full CI checks";
console.log(`\n${YELLOW}${banner} (via turbo)${NC}`);
turbo([...TURBO_TASKS[MODE], "--continue"]);

await runPhase("after-tests");
for (const call of LATER_TURBO[MODE]) turbo(call.args, call.env);
await runPhase("after-build");

if (MODE === "local") {
  console.log(`\n${YELLOW}Not run by --local (CI will):${NC} ${NOT_RUN_BY_LOCAL.join(", ")}`);
  console.log("  Run `pnpm check` for all of them.\n");
}

reportDeferred();

console.log(`\n${GREEN}All checks passed.${NC}`);
