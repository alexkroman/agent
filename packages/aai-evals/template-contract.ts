// Copyright 2026 the AAI authors. MIT license.
/**
 * Grade the coding agent on the TEMPLATE'S OWN behaviour contract.
 *
 * ## The gap this closes
 *
 * `starter.eval.test.ts` grades generated SOURCE: does a tool whose name or
 * description carries "cancel" exist, is the mode pipeline, is there a client
 * that reads live state. Every one of those is a question about structure, and
 * a generated retail desk can answer all of them while authenticating nobody.
 * The other half of this package — `openEvalSession`, `describeEval` — grades
 * BEHAVIOUR, and nothing has ever run it against generated code. So the two
 * halves sit disjoint, and the starter eval's verdict stops exactly where the
 * interesting question starts.
 *
 * ## Why the template's own eval file is the right contract
 *
 * Twelve of the eighteen starter prompts say "use the <name> template", which
 * makes the template the ask rather than an illustration — `checkCapabilities`
 * already special-cases them for that reason. Twenty-five of the twenty-six
 * templates ship an `agent.eval.test.ts`, and those files were written to be
 * runnable against a DEPLOYED agent rather than against their own directory:
 * they import `virtual:aai/agent`, which `aaiAgentPlugin` resolves against the
 * IMPORTER's directory. Drop one into a materialized workspace and it drives
 * that workspace's agent.
 *
 * They also assert MECHANISMS rather than prose — a refusal sentence, a tool
 * result, the projection sent to the browser — so they say nothing about which
 * words the model chose, which is what makes them survive a different-but-valid
 * implementation.
 *
 * ## The canonical copy always wins
 *
 * `use_template` copies template files verbatim into the workspace, so a
 * workspace may already CONTAIN an `agent.eval.test.ts` — one the coding agent
 * could then have edited. {@link contractWorkspace} overwrites it with the copy
 * read from `packages/aai-templates/`, which is the whole non-gameability
 * argument: the prompt is ours, the contract is ours, and the only thing the
 * agent controls is the agent.
 *
 * ## Cost, and why this is opt-in
 *
 * A contract run is a live model session on top of a codegen turn that already
 * takes minutes. `AAI_EVAL_CONTRACTS=1` turns it on; unset, {@link
 * runTemplateContract} is never called and the tier costs exactly what it did.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** The vitest config written beside a materialized workspace. */
const CONTRACT_CONFIG = `import { aaiAgentPlugin } from "@alexkroman1/aai/testing/vite";
import { defineConfig } from "vitest/config";

// Mirrors packages/aai-templates/vitest.config.ts: the plugin is what serves
// \`virtual:aai/agent\`, and it resolves against the importing file's directory —
// which here is the generated workspace, not the template it was copied from.
export default defineConfig({
  plugins: [aaiAgentPlugin()],
  test: { include: ["agent.eval.test.ts"], testTimeout: 300_000, hookTimeout: 300_000 },
});
`;

/** The file a template's behaviour contract lives in. */
export const CONTRACT_FILE = "agent.eval.test.ts";

/**
 * The template a prompt names, if it names one.
 *
 * The same pattern `starter-expectations.test.ts` uses to decide that a prompt's
 * ask IS a template — one declaration, because the two must agree: a prompt this
 * says names no template is one the grader holds to its capability list instead,
 * and a disagreement grades some starter twice and another not at all.
 */
export function templateNamed(prompt: string): string | undefined {
  return /\buse the (\S+) template\b/i.exec(prompt)?.[1]?.replace(/[.,]$/, "");
}

/**
 * The files to write for a contract run.
 *
 * The canonical contract is written LAST and unconditionally, so a workspace
 * that already carries an `agent.eval.test.ts` — `use_template` copies one — has
 * it replaced rather than trusted.
 */
export function contractWorkspace(
  files: Record<string, string>,
  contract: string,
): Record<string, string> {
  return { ...files, "vitest.config.ts": CONTRACT_CONFIG, [CONTRACT_FILE]: contract };
}

/** What a contract run concluded. */
export type ContractRun = {
  /** Was there a contract to run at all? */
  readonly ran: boolean;
  readonly passed: boolean;
  /** Why it did not run, or what failed. */
  readonly note: string;
};

/** Spawn a vitest run over a materialized workspace. Injected so the orchestration is testable. */
export type ContractRunner = (dir: string) => Promise<{ code: number; output: string }>;

/** How much of a failing run's output to keep. */
const MAX_NOTE = 800;

const condense = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);

/**
 * Read a template's contract, or say why there is none.
 *
 * A MISSING file is not a failure: one of the twenty-six templates ships no
 * eval, and a starter naming that one has nothing to be held to. A prompt naming
 * a template that does not EXIST is different — that is a starter and a
 * templates directory that disagree, and it is reported as a note rather than
 * silently skipped, because it means one starter is being graded on structure
 * alone while its author believes otherwise.
 */
export async function readContract(
  templatesDir: string,
  template: string,
): Promise<{ source?: string; note: string }> {
  const file = path.join(templatesDir, template, CONTRACT_FILE);
  try {
    return { source: await readFile(file, "utf-8"), note: "" };
  } catch {
    return { note: `no ${CONTRACT_FILE} for template "${template}"` };
  }
}

/**
 * Materialize a workspace and run the template's contract against it.
 *
 * The scratch directory lives UNDER this package on purpose: a template contract
 * imports `@alexkroman1/aai/protocol`, `@alexkroman1/aai-runtime/eval`, `vitest`
 * and `zod`, and Node resolution walks upward — so a directory inside
 * `packages/aai-evals/` resolves all four through the package's own
 * `node_modules` with nothing installed. A scratch directory in `tmpdir()`
 * resolves none of them.
 */
export async function runTemplateContract(opts: {
  readonly files: Record<string, string>;
  readonly prompt: string;
  readonly templatesDir: string;
  readonly scratchDir: string;
  readonly run: ContractRunner;
}): Promise<ContractRun> {
  const template = templateNamed(opts.prompt);
  if (template === undefined) {
    // Not a shortfall: six starters name no template, and holding one to a
    // contract it never asked for is the over-specification failure this
    // package's grader has been bitten by four times.
    return { ran: false, passed: true, note: "prompt names no template" };
  }
  const { source, note } = await readContract(opts.templatesDir, template);
  if (source === undefined) return { ran: false, passed: true, note };

  const written = contractWorkspace(opts.files, source);
  try {
    await mkdir(opts.scratchDir, { recursive: true });
    for (const [rel, body] of Object.entries(written)) {
      const target = path.join(opts.scratchDir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf-8");
    }
    const { code, output } = await opts.run(opts.scratchDir);
    return code === 0
      ? { ran: true, passed: true, note: "" }
      : { ran: true, passed: false, note: condense(output) };
  } finally {
    // A case REMOVES what it wrote, for the same reason it deletes its studio
    // project: this one writes a whole node-resolvable workspace INSIDE the
    // repo, so a leak is a directory tree that later `git status`, `biome check`
    // and `tsc` all walk into.
    await rm(opts.scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * How long one contract run may take.
 *
 * Above the 300s per-case budget the generated `vitest.config.ts` sets, so a
 * case that legitimately runs long ends with vitest's own diagnostic rather than
 * a killed child that says nothing. This bound only exists so a WEDGED run ends.
 */
const CONTRACT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run a command in a directory and collect its exit code and merged output.
 *
 * Separate from {@link spawnVitest} so the PLUMBING is testable without a
 * vitest install and a live model: capturing both streams, the `code ?? 1`
 * fallback for a signalled child, and the `error` path are what can break here,
 * and a test drives all three through `node -e`.
 *
 * Bounded with `spawn`'s own `signal` rather than a timer raced against the
 * exit — `guard-invariants` rule 3 bans the latter, and the signal additionally
 * KILLS the child, where a lost race would leave one running and holding the
 * scratch directory the `finally` is about to remove.
 */
export function spawnCommand(
  command: string,
  args: readonly string[],
  opts: { readonly env: Record<string, string>; readonly timeoutMs: number },
): ContractRunner {
  return (dir) =>
    new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: dir,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      let output = "";
      // Sync listeners: an `async` function handed to `.on` is `guard-invariants`
      // rule 23, and there is nothing to await here anyway.
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      // `error` fires for a spawn that never started AND for the abort, and both
      // are a contract that did not pass — reported with the reason rather than
      // left waiting on a `close` that will not come.
      child.on("error", (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
      // `null` is a child killed by a signal, which is a failure and not a pass.
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
}

/** The real runner: `vitest run` in the materialized workspace. */
export function spawnVitest(env: Record<string, string>): ContractRunner {
  return spawnCommand("npx", ["vitest", "run"], { env, timeoutMs: CONTRACT_TIMEOUT_MS });
}
