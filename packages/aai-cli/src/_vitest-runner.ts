// Copyright 2026 the AAI authors. MIT license.
/**
 * Running vitest over an agent project's specs — the launcher three commands
 * share.
 *
 * `aai test`, `aai eval` and `aai build`'s pre-build gate all spawn the
 * project's own vitest, and all three used to import it from `test.ts`. Nothing
 * about the code was wrong; what the import SAID was, because `aai eval` took
 * its runner from the file named after the other command. Those two are
 * deliberately disjoint — a positional argument to `vitest run` is a substring
 * FILTER rather than an include glob, so `agent.test.ts` cannot match
 * `agent.eval.test.ts` and neither command has to know the other's filenames
 * (see {@link runVitest}) — and an import edge between them is the one thing
 * that could quietly grow the coupling that design exists to prevent.
 *
 * What lives here is everything that follows from POINTING VITEST AT A SUBSET:
 * how the binary is resolved, which files a run covers, which ones it therefore
 * does NOT, and the notice a caller owes when it narrowed without saying so.
 * The tiers' own filenames stay with the commands that own them — `TEST_FILES`
 * in `test.ts`, `EVAL_FILES` in `eval.ts` — so this module has no opinion about
 * which tier is running, which is why {@link VitestRunOptions.candidates} has
 * no default.
 *
 * @module
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { execaSync } from "execa";
import { notify } from "./_ui.ts";
import {
  binFromPackageJson,
  compareCodeUnits,
  errorCode,
  errorMessage,
  formatCappedList,
} from "./_utils.ts";

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

/** Which files to run, and how — see {@link runVitest}. */
export type VitestRunOptions = {
  /**
   * File names to look for in the project root, in preference order.
   *
   * Required, and deliberately so: the tier is the CALLER's, and a default here
   * would be this module naming one of them.
   */
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
export function runVitest(cwd: string, opts: VitestRunOptions): string[] | false {
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
 * set is what `executeTest` refuses to call a pass, what it puts in its result
 * for a script to read, and what `--all` opts into running.
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

/**
 * The remedy, named the same way wherever the narrowing is reported.
 *
 * The project's own `npm test` comes FIRST because it is the command a
 * scaffolded project already ships (`scaffold/package.json`), so it is the one
 * answer that needs nothing installed or remembered; `--all` is the same thing
 * without leaving the CLI.
 */
export const WIDEN_HINT =
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
  notify("warn", `${preamble} ${formatCappedList(skipped)}. ${WIDEN_HINT}`);
}
