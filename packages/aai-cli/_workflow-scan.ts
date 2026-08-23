// Copyright 2026 the AAI authors. MIT license.
/**
 * What the BUILT flow bundle carries — the two scans that read it, and the
 * checks over them.
 *
 * Split out of `workflow-bundler.ts` when that file crossed the 500-line cap,
 * along the seam the two scans already share: both read the same artifact after
 * the builder has written it, both attribute a line to a module through
 * esbuild's `// <path>` headers, and neither has anything to do with
 * CONFIGURING the build. One of them fails the build (a `require` the workflow
 * VM cannot answer) and the other warns (a call that replays differently), which
 * is the only real difference between them.
 *
 * Internal: `workflow-bundler.ts` is the surface the studio and the CLI's own
 * build call, and it re-exports nothing from here that they need.
 *
 * @module _workflow-scan
 */

import { builtinModules } from "node:module";
import path from "node:path";

/**
 * Every Node builtin, in both spellings esbuild can emit for one.
 *
 * `node:child_process` and bare `child_process` are the same module and the
 * bundle may name it either way — a bare name only reaches the output when the
 * source imported it bare, which npm is still full of.
 */
const RUNTIME_MODULES: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/**
 * A `require(…)` CALL, excluding esbuild's own `__require` shim.
 *
 * The lookbehind is what separates the two: `__require` is the shim esbuild
 * writes for a bundled CJS module's dynamic requires, and the STEP bundle
 * defines a real `require` for it (see {@link STEP_REQUIRE_SHIM}). A bare
 * `require` in the FLOW bundle is the different thing this scan is for.
 */
const REQUIRE_CALL = /(?<![\w$.])require\(\s*"([^"]+)"\s*\)/g;

/** esbuild's per-module header — `// node_modules/pkg/index.js`, and nothing else. */
const MODULE_COMMENT = /^\/\/ (\S+\.[cm]?[jt]sx?)$/;

/** One `require` the workflow VM cannot answer, and the module it was written for. */
export type VmRequireSite = {
  /** The module specifier — `node:child_process`. */
  specifier: string;
  /** The bundled file esbuild attributed it to, or `undefined` when it said none. */
  module: string | undefined;
};

/**
 * Find the Node builtins a flow bundle would `require` at load.
 *
 * The flow bundle is compiled in a `node:vm` `Script` whose context has
 * `module` and `exports` and **no `require`**, so one of these is a run that
 * dies at replay with `ReferenceError: require is not defined` — never a build
 * failure, and never a symptom before the first run. The WDK's own builder
 * bundles everything for exactly this reason and carries
 * `createNodeModuleErrorPlugin` to reject a builtin import at build time.
 *
 * That plugin has two blind spots this scan covers, and both are the DEPLOYED
 * shape rather than an exotic one:
 *
 * - It reports a violation only when it can point at the import LINE in a
 *   first-party file, matched with a single-line regex — so a multi-line
 *   `import {\n  x,\n} from "pkg"` finds nothing and the builtin is marked
 *   external in silence.
 * - It resolves that file against `process.cwd()`, which is not the project
 *   being built when the studio builds a workspace, so the read fails and the
 *   same silent path is taken.
 *
 * Both were reproduced. What reaches the VM either way is
 * `var import_node_child_process = require("node:child_process");` at the top
 * of the bundle, i.e. every run of every workflow in the project fails, and the
 * stack names a line of generated code inside a dependency.
 *
 * Restricted to builtin specifiers deliberately: those are the only ones this
 * builder leaves external (it marks nothing else so, precisely so nothing can
 * need a `require`), and a narrow set is what keeps the scan from reading the
 * text of a prompt as a violation.
 *
 * @internal
 */
export function findVmRequires(workflowCode: string): VmRequireSite[] {
  const found: VmRequireSite[] = [];
  const seen = new Set<string>();
  let module: string | undefined;
  for (const line of workflowCode.split("\n")) {
    const header = MODULE_COMMENT.exec(line.trim());
    if (header) {
      module = header[1];
      continue;
    }
    for (const [, specifier] of line.matchAll(REQUIRE_CALL)) {
      if (specifier === undefined || !RUNTIME_MODULES.has(specifier)) continue;
      // A NUL separates the two halves (neither can contain one, so the key
      // cannot collide) and is spelled as an ESCAPE, never the raw byte: one
      // control character makes a file binary to `git grep`, and every ratchet
      // here is a `git grep`. See "Never write a control character" in AGENTS.md.
      const key = `${specifier}\u0000${module ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ specifier, module });
    }
  }
  return found;
}

/**
 * Calls whose answer differs between a run and its replays, and what to say
 * about each.
 *
 * **A workflow body REPLAYS from the top on every resume** — after a `sleep`,
 * after a redeploy, after the container was reclaimed — and only a step's
 * result is journaled. So a body that reads the clock gets a different time on
 * every pass, and a body that fetches performs the request again, both silently:
 * the run completes, and its output is built from values that disagree with the
 * ones the earlier passes saw. The scaffold guide has always carried this rule
 * with the words "all of which fail silently if broken", and nothing checked it.
 */
const REPLAY_UNSAFE: readonly { readonly re: RegExp; readonly fix: string }[] = [
  {
    re: /(?<![\w$.])Date\.now\s*\(/g,
    fix: 'reads a different clock on every replay — take the time in a `"use step"` body, whose result is journaled',
  },
  {
    re: /(?<![\w$.])new Date\s*\(\s*\)/g,
    fix: 'reads a different clock on every replay — take the time in a `"use step"` body, whose result is journaled',
  },
  {
    re: /(?<![\w$.])Math\.random\s*\(/g,
    fix: 'draws a different number on every replay — draw it in a `"use step"` body',
  },
  {
    re: /(?<![\w$.])crypto\.randomUUID\s*\(/g,
    fix: 'mints a different id on every replay — mint it in a `"use step"` body',
  },
  {
    re: /(?<![\w$.])fetch\s*\(/g,
    fix: 'runs again on every replay, and the VM has no fetch to run it with — call `stepFetch` from a `"use step"` body',
  },
];

/** One replay-unsafe call the flow bundle carries, and where it came from. */
export type ReplayUnsafeSite = {
  /** The call, as written — `Date.now(`. */
  call: string;
  /** What it does on a replay, and what to do instead. */
  fix: string;
  /** The project file esbuild attributed it to. */
  module: string;
};

/**
 * Replay-unsafe calls the flow bundle carries, attributed to the project's OWN
 * `workflows/` files.
 *
 * Attribution is the whole design. The bundle inlines every non-external
 * dependency a workflow module imports — zod, a markdown parser, whatever — and
 * third-party code is full of `Date.now()` on paths a workflow never reaches, so
 * a scan of the bundle's text reports a library and blocks a correct project.
 * esbuild writes a `// <path>` header per module (the same one
 * {@link findVmRequires} reads), so lines can be charged to the file they were
 * written in, and only the project's own workflow sources are read.
 *
 * Scanning the BUNDLE rather than the sources is what makes a `"use step"` body
 * exempt for free: the workflow-mode transform has already removed them, so
 * what is left is the part that really does replay.
 *
 * @internal
 */
export function findReplayUnsafeCalls(workflowCode: string): ReplayUnsafeSite[] {
  const found: ReplayUnsafeSite[] = [];
  const seen = new Set<string>();
  let module: string | undefined;
  for (const line of workflowCode.split("\n")) {
    const header = MODULE_COMMENT.exec(line.trim());
    if (header) {
      module = header[1];
      continue;
    }
    if (module === undefined || !isProjectWorkflowModule(module)) continue;
    for (const { re, fix } of REPLAY_UNSAFE) {
      for (const [call] of line.matchAll(re)) {
        // Same NUL-as-escape rule as `findVmRequires`.
        const key = `${call}\u0000${module}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ call, fix, module });
      }
    }
  }
  return found;
}

/**
 * Is this bundled module one of the project's own `workflows/` files?
 *
 * A dependency's path runs through `node_modules/`, which is excluded first so
 * a package that happens to live in a directory called `workflows` cannot be
 * read as the project's.
 */
function isProjectWorkflowModule(module: string): boolean {
  const posix = module.split(path.sep).join("/");
  return !posix.includes("node_modules/") && /(?:^|\/)workflows\//.test(posix);
}

/**
 * The warning `aai build` and `aai dev` print for a replay-unsafe call.
 *
 * A WARNING and not a build failure, deliberately. The attribution above makes
 * the scan accurate about which FILE a call is in, and it cannot know whether a
 * plain function in a `workflows/` module is reached from a body (where the
 * rule bites) or only from a step (where it does not) — so the one thing it
 * must not do is refuse a correct project. A silent build was the actual
 * problem; a line naming the file solves it without that risk.
 */
export function replayWarnings(workflowCode: string): string[] {
  return findReplayUnsafeCalls(workflowCode).map(
    ({ call, fix, module }) => `${module}: \`${call}…\` ${fix}.`,
  );
}

/**
 * Fail the build when the flow bundle carries a `require` — see
 * {@link findVmRequires} for what that means and why nothing upstream catches it.
 *
 * The message has to name the MODULE as well as the specifier, because the
 * import that caused it is not in the file an author is looking at: only a
 * `"use step"` body is stripped from this bundle, so a value a `workflows/`
 * module holds at module scope — an exported helper, a constant — keeps its
 * import, and that import's whole graph rides into the VM.
 */
export function assertNoVmRequires(workflowCode: string): void {
  const sites = findVmRequires(workflowCode);
  if (sites.length === 0) return;
  const lines = sites.map(
    ({ specifier, module }) => `  ${specifier}${module === undefined ? "" : ` — from ${module}`}`,
  );
  throw new Error(
    [
      "This project's workflows cannot run: the workflow bundle requires " +
        `${sites.length === 1 ? "a Node module" : "Node modules"} that the workflow VM has no ` +
        "`require` for.",
      ...lines,
      "",
      'Only a `"use step"` body is removed from this bundle, so anything a `workflows/` ' +
        "module holds at MODULE scope keeps its import — including an exported helper that " +
        "a step body is the only caller of. Move that use inside the step body, or into a " +
        "module only a step body imports.",
    ].join("\n"),
  );
}
