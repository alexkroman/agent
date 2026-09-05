// Copyright 2026 the AAI authors. MIT license.
/**
 * No third-party import in the two RELAXED programs resolves to a silent `any`.
 *
 * `tsconfig.scripts.json` and `tsconfig.browser.json` both set
 * `noImplicitAny: false`, each with a measured argument: they check
 * annotation-free JavaScript, where the flag reports ~500 TS7006 "this
 * parameter has no JSDoc" findings that are true of all of it and are not
 * defects. That relaxation is right, and it has a side effect nobody chose.
 *
 * **`noImplicitAny` is also what turns a missing declaration into an ERROR.**
 * With it off, an import of a package that ships no types is not TS7016
 * ("could not find a declaration file for module 'ws'") — it is an `any`, with
 * no diagnostic at all. So the one class of finding these programs exist to
 * catch is the one class they cannot report.
 *
 * That is not hypothetical. `tsconfig.scripts.json` mapped `ws` to
 * `packages/aai-runtime/node_modules/ws` — the implementation directory of a
 * plain JS package that bundles no declarations, with `@types/ws` installed and
 * catalog-pinned right beside it. `examples/host-server/bench/fakes.mjs`
 * imports `WebSocketServer` from it. The only third-party import in `examples/`
 * the compiler could have checked was silently untyped, and pointing the
 * mapping at the `@types` immediately surfaced a real defect: the bench totalled
 * audio bytes with `data.length` on a `RawData` union, which is `NaN` for the
 * `ArrayBuffer` arm and a CHUNK COUNT for the `Buffer[]` arm — a benchmark
 * printing a wrong number with nothing failing.
 *
 * ## What this gate does, and why it is not just `noImplicitAny: true`
 *
 * It re-runs each program with `--noImplicitAny` forced ON — a command-line
 * flag overrides the config's value — and asserts **zero TS7016**. It says
 * nothing about TS7006. That split is the whole design: the relaxation exists
 * for the parameter findings and is kept, while the module-resolution findings
 * it also suppressed become a hard failure. Turning the flag on in the config
 * instead would mean annotating 80 scripts before the compiler could report a
 * single real mistake.
 *
 * ## The liveness floor
 *
 * A gate whose healthy output is "zero" is the shape this repo keeps paying
 * for: a run that resolves nothing prints the same zero as a clean tree. So
 * each program also has to report at least {@link Program.minImplicitAny}
 * TS7006 findings. That number is not a quality bar — it is proof that the
 * forced flag really applied AND that the program really compiled its files,
 * which no count of TS7016 alone can distinguish from a tsc that never ran.
 * A/B'd by pointing a config's `include` at a directory that does not exist:
 * TS7016 stays 0 and the floor is what fails.
 *
 * Floors sit ~20% under the measured counts (scripts 493, browser 98) so an
 * ordinary refactor does not trip them while a program that stops resolving
 * does.
 *
 *   pnpm check:untyped-imports
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {object} Program
 * @property {string} config    Repo-relative tsconfig of a `noImplicitAny: false` program.
 * @property {number} minImplicitAny  Liveness floor — see the module doc.
 */

/** The two relaxed programs. A third would default IN by being added here. */
const PROGRAMS = [
  { config: "tsconfig.scripts.json", minImplicitAny: 400 },
  { config: "tsconfig.browser.json", minImplicitAny: 80 },
];

/**
 * Run one program with `--noImplicitAny` forced on and hand back the output.
 *
 * tsc exits NON-ZERO here by construction — hundreds of TS7006 are expected —
 * so the throw is the normal path and the diagnostics live on `err.stdout`.
 * stderr and a spawn failure are folded in for the reason `_scaffold-tsc.mjs`
 * gives: a missing binary or an unloadable config says so there, and
 * discarding it turns a toolchain problem into an empty, healthy-looking run.
 *
 * @param {string} config
 * @returns {string}
 */
function diagnose(config) {
  const tsc = path.join(REPO_ROOT, "node_modules/.bin/tsc");
  const args = ["-p", path.join(REPO_ROOT, config), "--noEmit", "--noImplicitAny"];
  try {
    return execFileSync(tsc, args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: "pipe" });
  } catch (err) {
    const stdout = String(err.stdout ?? "");
    const stderr = String(err.stderr ?? "");
    const spawnFailure = err.stdout === undefined && err.stderr === undefined ? String(err) : "";
    return [stdout, stderr, spawnFailure].filter((part) => part.trim() !== "").join("\n");
  }
}

/** Lines carrying a given TS error code. @param {string} out @param {number} code */
const withCode = (out, code) => out.split("\n").filter((line) => line.includes(`error TS${code}:`));

console.log("check-untyped-imports: TS7016 in the `noImplicitAny: false` programs\n");

let failed = false;
for (const { config, minImplicitAny } of PROGRAMS) {
  const out = diagnose(config);
  const untyped = withCode(out, 7016);
  const live = withCode(out, 7006).length;

  console.log(
    `  ${config.padEnd(24)} untyped imports=${untyped.length}  (liveness: ${live} TS7006, floor ${minImplicitAny})`,
  );

  if (live < minImplicitAny) {
    failed = true;
    console.error(
      `\ncheck-untyped-imports: ${config} reported only ${live} TS7006, under its floor of ` +
        `${minImplicitAny}.\nThat is not a pass — it means the forced flag did not apply or the ` +
        `program compiled\nalmost nothing, so its TS7016 count of ${untyped.length} means nothing ` +
        "either. Check that\nthe config still resolves and that its `include` still matches files.\n",
    );
    if (out.trim() !== "") console.error(out.split("\n").slice(0, 15).join("\n"));
  }

  if (untyped.length > 0) {
    failed = true;
    console.error(`\ncheck-untyped-imports: ${config} imports a module with no declarations.\n`);
    for (const line of untyped) console.error(`  ${line}`);
    console.error(
      "\nUnder this program's `noImplicitAny: false` that import is a silent `any`, not an\n" +
        "error — which is why this gate forces the flag back on. Install the package's\n" +
        "`@types`, or point the `paths` entry at the `@types` rather than the\n" +
        "implementation directory (a JS package ships no declarations of its own).\n",
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `\ncheck-untyped-imports: ${PROGRAMS.length} relaxed program(s), no untyped imports. ✓`,
  );
}
