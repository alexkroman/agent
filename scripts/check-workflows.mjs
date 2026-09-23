#!/usr/bin/env node

/**
 * actionlint and zizmor over `.github/workflows/`.
 *
 * Agents edit `check.yml` and `ship.yml` more than any other config in the repo,
 * and until this gate nothing read them except GitHub, at run time, on the
 * branch that broke them. The `aai-gates` specs pin particular CONTRACTS (the
 * push list, the ship job graph, the tag backfill) and none of them is a
 * general checker:
 *
 * - **actionlint** type-checks the workflow language itself — `${{ }}`
 *   expressions, `needs` references, job outputs, runner labels — and runs
 *   ShellCheck over every `run:` block when `shellcheck` is on PATH, which is
 *   the half of our shell `check:shell` cannot reach.
 * - **zizmor** audits for the security shapes: template injection, a token
 *   with default (write) scopes, credentials persisted into a checkout that a
 *   later step could exfiltrate. Its first run here reported 30 findings, all
 *   fixed rather than configured away; the two checkouts that genuinely PUSH
 *   carry an inline `# zizmor: ignore[artipacked]` with the reason.
 *
 * **The zizmor policy is read from the BASE ref when one is given** (`--base`,
 * which CI passes as `origin/main`). A pull request that weakens
 * `.github/zizmor.yml` is otherwise audited under the weakened policy it
 * introduces, so the change approves itself; read from the base, it takes
 * effect only once it has merged. No policy file on the base means zizmor's
 * defaults (`--no-config`), and a working-tree one is announced as ignored.
 *
 * Offline audits only. The online ones (known-vulnerable actions, impostor
 * commits) need a token and a network, and a gate whose verdict depends on the
 * advisory database at the moment of the run cannot be reproduced locally.
 *
 * Both are single binaries with no pnpm package that pins a version, so they
 * come from PATH like ShellCheck does (`ACTIONLINT` / `ZIZMOR` override it):
 * CI installs pinned versions in `check.yml`. A missing binary is ANNOUNCED and
 * skipped locally, and a FAILURE under `AAI_REQUIRE_WORKFLOW_LINT=1`, which CI
 * sets — the `AAI_REQUIRE_SHELLCHECK` shape, so the one run that must lint
 * cannot pass by not finding the tool.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const GATE = "check:workflows";
const ROOT = repoRoot(import.meta.url);
const WORKFLOWS = ".github/workflows";
const POLICY = ".github/zizmor.yml";
/** Measured 2026-09: 6 (artifact-size, check, docs, label, ship, stale). */
const MIN_WORKFLOWS = 6;

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { base: { type: "string" } },
});

const REQUIRED = process.env.AAI_REQUIRE_WORKFLOW_LINT === "1";
const TOOLS = [
  {
    name: "actionlint",
    bin: process.env.ACTIONLINT || "actionlint",
    install: "`brew install actionlint`, or `pipx install actionlint-py`",
  },
  {
    name: "zizmor",
    bin: process.env.ZIZMOR || "zizmor",
    install: "`brew install zizmor`, or `pipx install zizmor`",
  },
];

/** The binaries that are present; exits when one is missing and required. */
function availableTools() {
  const found = [];
  for (const tool of TOOLS) {
    const probe = spawnSync(tool.bin, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      found.push(tool);
      continue;
    }
    const hint = `install it (${tool.install}) or set ${tool.name.toUpperCase()}`;
    if (REQUIRED) {
      console.error(
        `${GATE}: \`${tool.bin}\` not found, and AAI_REQUIRE_WORKFLOW_LINT=1 — ${hint}`,
      );
      process.exit(1);
    }
    console.warn(`${GATE}: ${tool.name} SKIPPED — \`${tool.bin}\` not found; ${hint}`);
  }
  return found;
}

/** Every tracked workflow file, repo-relative. */
function workflowFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", WORKFLOWS], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.ya?ml$/.test(file));
}

/**
 * The zizmor arguments naming its policy: the BASE ref's copy when `--base` is
 * given, else the working tree's. Returns the args and a cleanup.
 */
function policyArgs() {
  if (FLAGS.base === undefined) {
    return {
      args: existsSync(join(ROOT, POLICY)) ? ["--config", POLICY] : ["--no-config"],
      done() {},
    };
  }
  const shown = spawnSync("git", ["show", `${FLAGS.base}:${POLICY}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    if (existsSync(join(ROOT, POLICY))) {
      console.warn(
        `${GATE}: ${POLICY} is not on ${FLAGS.base} yet — auditing under zizmor's defaults until it lands.`,
      );
    }
    return { args: ["--no-config"], done() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "zizmor-policy-"));
  const file = join(dir, "zizmor.yml");
  writeFileSync(file, shown.stdout);
  return { args: ["--config", file], done: () => rmSync(dir, { recursive: true, force: true }) };
}

const tools = availableTools();
const files = workflowFiles();
if (files.length < MIN_WORKFLOWS) {
  console.error(
    `${GATE}: found ${files.length} workflow file(s), under the floor of ${MIN_WORKFLOWS} — ` +
      "the discovery is broken, or workflows were deleted (lower MIN_WORKFLOWS with them)",
  );
  process.exit(1);
}

let failed = false;
for (const tool of tools) {
  let args = [...files];
  let done = () => {};
  if (tool.name === "zizmor") {
    const policy = policyArgs();
    done = policy.done;
    const format = process.env.GITHUB_ACTIONS === "true" ? "github" : "plain";
    args = ["--offline", "--no-progress", `--format=${format}`, ...policy.args, ...files];
  }
  const result = spawnSync(tool.bin, args, { cwd: ROOT, stdio: "inherit" });
  done();
  if (result.status !== 0) {
    console.error(`${GATE}: ${tool.name} reported findings (exit ${result.status ?? "signal"})`);
    failed = true;
  }
}
if (failed) process.exit(1);
if (tools.length > 0) {
  console.log(
    `${GATE}: ${files.length} workflow(s) clean under ${tools.map((t) => t.name).join(" + ")}`,
  );
}
