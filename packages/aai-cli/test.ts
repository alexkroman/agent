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

type TestData = { passed: boolean; skipped?: boolean };

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
  /** Extra vitest CLI arguments, inserted before the file name. */
  readonly extraArgs?: readonly string[];
  /**
   * Variables to add to the child's environment. Absent leaves the child with
   * the parent's env untouched, which is what `aai test` wants; `aai eval`
   * passes the project's `.env` so an eval can reach the provider key the same
   * way a session under `aai dev` does.
   */
  readonly env?: Record<string, string>;
};

/**
 * Run vitest over one of `candidates` in the given project directory.
 *
 * Returns the FILE it ran, or `false` if none of the candidate files exists.
 * Throws on failure.
 *
 * A vitest FILTER, not an include glob: the argument is matched as a substring
 * against the paths vitest's own include globs already found, which is why the
 * candidates are named `*.test.ts` — `agent.test.ts` cannot match
 * `agent.eval.test.ts` and vice versa, so the two commands stay disjoint
 * without either one having to exclude the other's file.
 */
export function runVitest(
  cwd: string,
  opts: VitestRunOptions = { candidates: TEST_FILES },
): string | false {
  const testFile = opts.candidates.find((name) => existsSync(path.join(cwd, name)));
  if (!testFile) return false;

  const { cmd, args } = resolveVitestCommand(cwd);
  // No NODE_OPTIONS override: this used to force `--experimental-strip-types`,
  // which is redundant on every Node this CLI supports (`engines.node >=24`) —
  // type stripping has been on by default since 23.6, and in Node 26 the flag
  // survives only as an alias for `--strip-types`. Setting NODE_OPTIONS is not
  // free either: it propagates to every vitest worker, so a value that ever
  // stops being accepted would fail the whole run rather than degrade.
  execaSync(cmd, [...args, "run", "--root", ".", ...(opts.extraArgs ?? []), testFile], {
    cwd,
    stdio: "inherit",
    // `omitUndefined`, not a conditional spread: `guard-invariants` rule 2.
    ...omitUndefined({ env: opts.env ? { ...process.env, ...opts.env } : undefined }),
  });

  // The NAME rather than `true`: the caller reports what ran, and
  // `warnUnrunSpecs` reports what did not, so the two cannot disagree.
  return testFile;
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
 * Spec files in the project that `aai test` did NOT run.
 *
 * `runVitest` passes ONE filename as a vitest FILTER, which is what keeps `test`
 * and `eval` disjoint without either excluding the other's file — see its doc.
 * The cost is that every other `*.test.ts` in the project is skipped, and the
 * skip was SILENT: the shipped `retail` template carries seven of them, so
 * `aai test` there ran 1 file / 67 tests, printed "Tests passed", and left
 * 211 of the project's 278 tests unrun with nothing saying so.
 *
 * A silent skip is the worst outcome available, so the skip is announced rather
 * than the filter widened: which files `aai test` runs is a documented contract
 * (the scaffold guide says "Run agent.test.ts via vitest"), and running a
 * project's other specs by default could reach ones that are slow or want
 * credentials. Naming them costs nothing and is what a reader needs.
 *
 * Eval files are excluded because they have their OWN command, named in the
 * message.
 */
export function unrunSpecFiles(cwd: string, ran: string): string[] {
  const found: string[] = [];
  collectSpecs(cwd, "", ran, found);
  // Code-unit order, never `localeCompare`: with no explicit locale that answers
  // to the runtime's ICU, so the same project would warn in a different order on
  // a different machine.
  return found.sort(compareCodeUnits);
}

/** Code-unit comparison — see {@link unrunSpecFiles} for why not `localeCompare`. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** One directory of {@link unrunSpecFiles}, recursing into the ones that count. */
function collectSpecs(dir: string, prefix: string, ran: string, out: string[]): void {
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
        collectSpecs(path.join(dir, e.name), rel, ran, out);
      }
    } else if (isUnrunSpec(e.name, rel, ran)) {
      out.push(rel);
    }
  }
}

/** A spec file this run did not cover. The `.eval.` INFIX is the tier convention. */
function isUnrunSpec(name: string, rel: string, ran: string): boolean {
  if (!SPEC_FILE_RE.test(name)) return false;
  return rel !== ran && !name.includes(".eval.test.");
}

/**
 * Warn, once, naming the spec files this run did not cover.
 *
 * `ran` is `false` when there was no `agent.test.ts` to run, and that case
 * needs the warning MORE rather than less: `aai test` then prints "No test file
 * found" while the project's spec files sit right there unrun, which reads as
 * "this project has no tests". Measured on a project whose only spec was
 * `tools/echo_back.test.ts` — `{"passed":true,"skipped":true}` and not a word
 * about it. It stays silent when there is nothing to name, in both arms.
 */
export function warnUnrunSpecs(cwd: string, ran: string | false): void {
  const skipped = unrunSpecFiles(cwd, ran === false ? "" : ran);
  if (skipped.length === 0) return;
  const preamble =
    ran === false
      ? `\`aai test\` found no agent.test.ts, so it ran nothing. ${skipped.length} spec file(s) exist and were NOT run:`
      : `\`aai test\` ran ${ran} only. ${skipped.length} other spec file(s) were NOT run:`;
  notify(
    "warn",
    `${preamble} ${skipped.join(", ")}. Run them with your own vitest ` +
      "(`npx vitest run`); behaviour evals have their own command (`aai eval`).",
  );
}

/** Execute agent tests and return structured result. */
export async function executeTest(cwd: string): Promise<CommandResult<TestData>> {
  log.step("Running agent tests");
  try {
    const ran = runVitest(cwd);
    if (!ran) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      // AFTER that line for the same reason as below: what ran (nothing) is
      // stated before what did not.
      warnUnrunSpecs(cwd, ran);
      return ok({ passed: true, skipped: true });
    }
    log.success("Tests passed");
    // AFTER the success line, so what ran is stated before what did not.
    warnUnrunSpecs(cwd, ran);
    return ok({ passed: true });
  } catch (err: unknown) {
    const { code, message } = classifyVitestError(err);
    return fail(code, message);
  }
}
