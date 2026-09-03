// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai test` — run agent tests via vitest.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { execaSync } from "execa";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log, notify } from "./_ui.ts";
import { binFromPackageJson, errorCode, errorMessage } from "./_utils.ts";

/**
 * What `aai test` measured, not merely whether it exited 0.
 *
 * `passed` alone is what made a narrowed run indistinguishable from a complete
 * one in a script (`jq -e .data.passed` was true either way), so the set it
 * covered rides the result: `ran` is what vitest was pointed at, `unrun` is what
 * it was not, and `complete` is the one field a CI job needs to read.
 */
type TestData = {
  passed: boolean;
  skipped?: boolean;
  /** Spec files this run covered, project-relative, code-unit sorted. */
  ran: string[];
  /** Spec files in the project this run did NOT cover — empty when complete. */
  unrun: string[];
  /** Whether the run covered every non-eval spec file in the project. */
  complete: boolean;
};

/**
 * Resolve the agent project's own vitest binary so tests run without the
 * npx resolution overhead (and its potential network fetch of vitest).
 *
 * Resolves `vitest/package.json` from the agent directory, derives the bin
 * script, and runs it with the current Node executable. Falls back to
 * `npx vitest` only when no local install is resolvable.
 */
export function resolveVitestCommand(
  cwd: string,
  // Injectable for tests: vitest's own worker sets NODE_PATH, which would
  // make the real resolver always succeed under `pnpm test`.
  resolve: (id: string) => string = createRequire(path.join(cwd, "package.json")).resolve,
): { cmd: string; args: string[] } {
  try {
    const bin = binFromPackageJson(resolve("vitest/package.json"), "vitest");
    if (bin) {
      // Run the bin JS with the current Node executable — avoids relying on
      // node_modules/.bin shims (shell wrappers, platform differences).
      return { cmd: process.execPath, args: [bin] };
    }
  } catch {
    /* not installed locally — fall through to npx */
  }
  return { cmd: "npx", args: ["vitest"] };
}

/** The files `aai test` runs, in preference order. */
export const TEST_FILES = ["agent.test.ts", "agent.test.js"] as const;

/** Which files to run, and how — see {@link runVitest}. */
export type VitestRunOptions = {
  /** File names to look for in the project root, in preference order. */
  readonly candidates: readonly string[];
  /** Extra vitest CLI arguments, inserted before the file names. */
  readonly extraArgs?: readonly string[];
  /**
   * Variables to add to the child's environment. Absent leaves the child with
   * the parent's env untouched, which is what `aai test` wants; `aai eval`
   * passes the project's `.env` so an eval can reach the provider key the same
   * way a session under `aai dev` does.
   */
  readonly env?: Record<string, string>;
  /**
   * Run EVERY non-eval spec in the project rather than the first candidate.
   *
   * The opt-in half of the narrowing documented on {@link unrunSpecFiles}: the
   * default stays one file, and this is how a caller says "I want the whole
   * suite" without the command having to guess. Still a filter list rather than
   * an include glob, so the eval tier stays disjoint by construction.
   */
  readonly all?: boolean;
  /**
   * Whether THIS function announces the specs it did not run.
   *
   * Default TRUE, and the default is the point: the caller most in need of the
   * notice is the one that does not know it is narrowing. `aai build` runs this
   * as its pre-build gate and reports nothing of its own, so a build gated on
   * one file out of eight said so nowhere. `aai test` and `aai eval` pass
   * `false` — the first because it reports the same set itself, in its result
   * as well as its output, and the second because "did not run" is a claim
   * about the TEST tier and every unit spec in the project would be named
   * falsely by an eval run.
   */
  readonly announceUnrun?: boolean;
};

/**
 * Run vitest over `candidates` (or, with `all`, the whole project) in the given
 * project directory.
 *
 * Returns the FILES it ran, or `false` if there was nothing to run. Throws on
 * failure.
 *
 * A vitest FILTER, not an include glob: each argument is matched as a substring
 * against the paths vitest's own include globs already found, which is why the
 * candidates are named `*.test.ts` — `agent.test.ts` cannot match
 * `agent.eval.test.ts` and vice versa, so the two commands stay disjoint
 * without either one having to exclude the other's file. That holds for the
 * `all` list too: it is built from {@link projectSpecFiles}, which drops the
 * eval tier by infix.
 */
export function runVitest(
  cwd: string,
  opts: VitestRunOptions = { candidates: TEST_FILES },
): string[] | false {
  const files = resolveRunFiles(cwd, opts);
  if (files.length === 0) return false;

  const { cmd, args } = resolveVitestCommand(cwd);
  // No NODE_OPTIONS override: this used to force `--experimental-strip-types`,
  // which is redundant on every Node this CLI supports (`engines.node >=24`) —
  // type stripping has been on by default since 23.6, and in Node 26 the flag
  // survives only as an alias for `--strip-types`. Setting NODE_OPTIONS is not
  // free either: it propagates to every vitest worker, so a value that ever
  // stops being accepted would fail the whole run rather than degrade.
  execaSync(cmd, [...args, "run", "--root", ".", ...(opts.extraArgs ?? []), ...files], {
    cwd,
    stdio: "inherit",
    // `omitUndefined`, not a conditional spread: `guard-invariants` rule 2.
    ...omitUndefined({ env: opts.env ? { ...process.env, ...opts.env } : undefined }),
  });

  // Announced AFTER the run, so a reader sees vitest's own summary and then
  // what it did not cover. `announceUnrun` defaults on — see the option's doc.
  if (opts.announceUnrun !== false) warnUnrunSpecs(cwd, files);

  // The NAMES rather than `true`: the caller reports what ran, and
  // `unrunSpecFiles` reports what did not, so the two cannot disagree.
  return files;
}

/** The spec files one {@link runVitest} call points vitest at. */
function resolveRunFiles(cwd: string, opts: VitestRunOptions): string[] {
  if (opts.all) return projectSpecFiles(cwd);
  const candidate = opts.candidates.find((name) => existsSync(path.join(cwd, name)));
  return candidate ? [candidate] : [];
}

/**
 * Classify a {@link runVitest} failure. execaSync throws an ENOENT-coded
 * error when the binary itself couldn't be spawned (infrastructure problem)
 * and an exit-code error when vitest ran and the tests failed.
 */
export function classifyVitestError(
  err: unknown,
  /** What failed, for the message — `aai eval` runs the same runner. */
  label = "Tests",
): {
  code: "spawn_failed" | "test_failed";
  message: string;
} {
  if (errorCode(err) === "ENOENT") {
    return {
      code: "spawn_failed",
      // execFileSync's ENOENT message names the missing binary ("spawnSync npx ENOENT").
      message: `Could not launch the test runner: ${errorMessage(err)} — is the binary on your PATH?`,
    };
  }
  return { code: "test_failed", message: `${label} failed: ${errorMessage(err)}` };
}

/** Directories a project's own specs never live in. */
const UNSCANNED_DIRS = new Set(["node_modules", ".aai", ".git", "dist", ".workflow-data"]);

/** What counts as a spec file. */
const SPEC_FILE_RE = /\.test\.(ts|js|tsx|mts|cts)$/;

/**
 * Every spec file in the project that belongs to the TEST tier.
 *
 * Eval files are excluded by the `.eval.` INFIX — the tier convention — rather
 * than by a filename list, which is what keeps this module from importing
 * `eval.ts`, which imports this one.
 */
export function projectSpecFiles(cwd: string): string[] {
  const found: string[] = [];
  collectSpecs(cwd, "", found);
  // Code-unit order, never `localeCompare`: with no explicit locale that answers
  // to the runtime's ICU, so the same project would report in a different order
  // on a different machine.
  return found.sort(compareCodeUnits);
}

/**
 * Spec files in the project that a run over `ran` did NOT cover.
 *
 * `runVitest` passes the candidate filename as a vitest FILTER, which is what
 * keeps `test` and `eval` disjoint without either excluding the other's file —
 * see its doc. The cost is that every other `*.test.ts` in the project is
 * skipped, and the skip was SILENT: the shipped `retail` template carries seven
 * of them, so `aai test` there ran 1 file / 67 tests, printed "Tests passed",
 * and left 211 of the project's 278 tests unrun with nothing saying so.
 *
 * The narrow default STANDS — which files `aai test` runs is a documented
 * contract (the scaffold guide says "Run agent.test.ts via vitest"), and running
 * a project's other specs by default could reach ones that are slow or want
 * credentials. What does not stand is a GREEN VERDICT over the difference: this
 * set is what {@link executeTest} refuses to call a pass, what it puts in its
 * result for a script to read, and what `--all` opts into running.
 */
export function unrunSpecFiles(cwd: string, ran: RanSpecs): string[] {
  const covered = new Set(coveredList(ran));
  return projectSpecFiles(cwd).filter((rel) => !covered.has(rel));
}

/**
 * What a caller reports as covered: one filename, a list of them, or `false`
 * for a run that found nothing to point vitest at.
 */
export type RanSpecs = string | readonly string[] | false;

/** {@link RanSpecs} as a list, so nothing downstream re-derives the three cases. */
function coveredList(ran: RanSpecs): readonly string[] {
  if (ran === false) return [];
  return typeof ran === "string" ? [ran] : ran;
}

/** Code-unit comparison — see {@link projectSpecFiles} for why not `localeCompare`. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** One directory of {@link projectSpecFiles}, recursing into the ones that count. */
function collectSpecs(dir: string, prefix: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is not this command's problem to report.
    return;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!(UNSCANNED_DIRS.has(e.name) || e.name.startsWith("."))) {
        collectSpecs(path.join(dir, e.name), rel, out);
      }
    } else if (SPEC_FILE_RE.test(e.name) && !e.name.includes(".eval.test.")) {
      out.push(rel);
    }
  }
}

/** How many unrun spec names a message prints before it starts counting. */
const MAX_NAMED_SPECS = 10;

/** The unrun set as one phrase — capped, because a project may hold hundreds. */
function formatSpecList(files: readonly string[]): string {
  const named = files.slice(0, MAX_NAMED_SPECS).join(", ");
  const rest = files.length - MAX_NAMED_SPECS;
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * The remedy, named the same way wherever the narrowing is reported.
 *
 * The project's own `npm test` comes FIRST because it is the command a
 * scaffolded project already ships (`scaffold/package.json`), so it is the one
 * answer that needs nothing installed or remembered; `--all` is the same thing
 * without leaving the CLI.
 */
const WIDEN_HINT =
  'Run the whole suite with this project\'s `npm test` (`vitest run --exclude "**/*.eval.test.*"`) ' +
  "or `aai test --all`; behaviour evals have their own command (`aai eval`).";

/**
 * Warn, once, naming the spec files this run did not cover.
 *
 * This is the notice for a caller whose own result says nothing about the
 * narrowing — today that is `aai build`'s pre-build gate, which ran one file
 * out of eight and printed "Build complete". `aai test` does not use it: an
 * incomplete run is a FAILURE there, and the failure's own message is the
 * report.
 */
export function warnUnrunSpecs(cwd: string, ran: RanSpecs): void {
  const skipped = unrunSpecFiles(cwd, ran);
  if (skipped.length === 0) return;
  const ranList = coveredList(ran);
  const preamble =
    ranList.length === 0
      ? `No agent.test.ts, so vitest ran nothing. ${skipped.length} spec file(s) exist and were NOT run:`
      : `vitest ran ${ranList.join(", ")} only. ${skipped.length} other spec file(s) were NOT run:`;
  notify("warn", `${preamble} ${formatSpecList(skipped)}. ${WIDEN_HINT}`);
}

/** What `aai test` was asked to cover. */
export type TestOptions = {
  /** Run every non-eval spec in the project rather than `agent.test.ts` alone. */
  readonly all?: boolean | undefined;
};

/**
 * Execute agent tests and return structured result.
 *
 * **An incomplete run is not a pass.** For as long as this command answered
 * `{"ok":true,"data":{"passed":true}}` with exit 0 over specs it had not run,
 * the scaffold's `"test": "aai test"` was what users wired into CI — so a suite
 * of 25 tests could go red in the editor and green in the pipeline, and adding
 * one tool could break `registry.test.ts` in 17 assertions with `pnpm test` and
 * `pnpm build` both staying green throughout. It is the same defect
 * `defineExec`'s `cwd` policy exists for (a green result for a project that is
 * not there), one directory over, and it gets the same answer: the command
 * fails, names the files, and names the flag that runs them.
 */
export async function executeTest(
  cwd: string,
  opts: TestOptions = {},
): Promise<CommandResult<TestData>> {
  log.step(opts.all ? "Running project tests" : "Running agent tests");
  try {
    // `announceUnrun: false`: this function reports the same set itself, in the
    // result as well as the output, and reporting it twice reads as two findings.
    const ran = runVitest(cwd, {
      candidates: TEST_FILES,
      announceUnrun: false,
      ...omitUndefined({ all: opts.all }),
    });
    const unrun = unrunSpecFiles(cwd, ran);
    if (unrun.length > 0) return incomplete(ran, unrun);
    if (ran === false) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true, ran: [], unrun: [], complete: true });
    }
    log.success(`Tests passed (${ran.length} spec file(s))`);
    return ok({ passed: true, ran, unrun: [], complete: true });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err);
    return fail(code, message);
  }
}

/**
 * The verdict for a run that left specs uncovered.
 *
 * Both arms fail, and the `ran === false` arm is the one that had misled
 * longest: `aai test` printed "No test file found" while the project's specs sat
 * right there unrun, which reads as "this project has no tests". Measured on a
 * project whose only spec was `tools/echo_back.test.ts` — `{"passed":true,
 * "skipped":true}`, exit 0, and not a word about it.
 */
function incomplete(ran: string[] | false, unrun: string[]): CommandResult<never> {
  const preamble =
    ran === false
      ? `\`aai test\` found no agent.test.ts, so it ran nothing, but ${unrun.length} spec file(s) exist`
      : `\`aai test\` ran ${ran.join(", ")} only — ${unrun.length} other spec file(s) in this project were not run`;
  return fail(
    "incomplete_run",
    `${preamble}: ${formatSpecList(unrun)}. An unrun spec is not a passing one, so this is not a green result.`,
    WIDEN_HINT,
  );
}
