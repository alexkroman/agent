// Copyright 2026 the AAI authors. MIT license.
// Shared plumbing for citty command definitions (cli.ts and
// _studio-commands.ts): common args, the working-directory setup, and the
// one output-mode/error/result emitter every command body runs under.

import path from "node:path";
import { isRecord } from "@alexkroman1/aai/utils";
import {
  type ArgsDef,
  type CommandDef,
  type CommandMeta,
  defineCommand,
  type ParsedArgs,
  type Resolvable,
} from "citty";
import {
  CliError,
  type CommandResult,
  fail,
  getOutputMode,
  type OutputMode,
  writeLine,
} from "./_output.ts";
import { log, silenceOutput } from "./_ui.ts";
import { AGENT_ENTRY, errorMessage, fileExists, resolveCwd } from "./_utils.ts";

/** Shared arg definitions for citty commands. */
export const sharedArgs = {
  server: { type: "string", alias: "s", description: "Platform server URL" },
  yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  json: { type: "boolean", description: "Output JSON (auto-detected in non-TTY)" },
} as const;

/** Flags citty handles itself, so no command declares them. */
const BUILTIN_FLAGS = new Set(["help", "h", "version", "v"]);

/**
 * Flags in `rawArgs` that `argsDef` doesn't declare, in the form the user
 * typed them.
 *
 * citty silently drops an unrecognized flag, so `aai push --serverr=http://x`
 * exited 0 having pushed to the DEFAULT server — production, for an installed
 * CLI — as if the flag had been honoured. Since `--server` is what decides
 * where the API key and secret values are sent, a typo quietly retargeting it
 * is worth failing on.
 */
export function findUnknownFlags(rawArgs: string[], argsDef: ArgsDef): string[] {
  const declared = declaredFlagNames(argsDef);
  const unknown: string[] = [];
  for (const raw of rawArgs) {
    // Everything after a bare `--` is positional by convention.
    if (raw === "--") break;
    const token = flagToken(raw);
    if (token && !declared.has(canonicalFlag(token))) unknown.push(token);
  }
  return unknown;
}

/**
 * A flag's comparison key: dashes dropped and lower-cased, with a leading
 * `no` negation removed.
 *
 * citty accepts both `--allowPreviewSlug` and `--allow-preview-slug` for an
 * arg declared as `allowPreviewSlug`, and the guest's in-sandbox Publish
 * spawns the kebab-case spelling. Comparing the literal text rejected the
 * kebab-case form as unknown and broke Publish for every studio user, so both
 * sides are normalized to one key.
 */
function canonicalFlag(flag: string): string {
  return flag.replace(/^--?/, "").replace(/^no-/, "").replace(/-/g, "").toLowerCase();
}

/** Every flag name and alias `argsDef` declares, plus citty's built-ins. */
function declaredFlagNames(argsDef: ArgsDef): Set<string> {
  const declared = new Set([...BUILTIN_FLAGS].map(canonicalFlag));
  for (const [name, def] of Object.entries(argsDef)) {
    const { type, alias } = def as { type?: string; alias?: string | string[] };
    if (type === "positional") continue;
    declared.add(canonicalFlag(name));
    if (typeof alias === "string") declared.add(canonicalFlag(alias));
    else if (Array.isArray(alias)) for (const a of alias) declared.add(canonicalFlag(a));
  }
  return declared;
}

/** The flag part of `raw` (`--server` from `--server=x`), or null if positional. */
function flagToken(raw: string): string | null {
  // A lone `-` is a conventional stdin placeholder; `-42` is a negative number.
  if (!raw.startsWith("-") || raw === "-" || /^-\d/.test(raw)) return null;
  const eq = raw.indexOf("=");
  return eq === -1 ? raw : raw.slice(0, eq);
}

/**
 * Any command in the tree, regardless of its args shape — the walk below only
 * reads `subCommands` and `args`, and the concrete generics differ per command.
 */
type AnyCommandDef = CommandDef<ArgsDef>;

/** Resolve a possibly-nested `Resolvable` citty field. */
async function resolve<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/**
 * `aai secret put` for a subcommand, `aai` for the root — the name to put in
 * front of `--help` when telling someone which usage to read.
 *
 * Beside {@link resolve} because it is the same job: `meta` is a `Resolvable`,
 * so only the plain-object form carries a name synchronously and anything else
 * degrades to the binary name rather than blocking an error path on a resolve.
 * This module owns citty's `Resolvable` handling; `cli.ts` had its own copy of
 * the narrowing.
 */
export function commandPath<T extends ArgsDef>(cmd: CommandDef<T>, parent?: CommandDef<T>): string {
  const nameOf = (c: CommandDef<T> | undefined): string | undefined => {
    const meta = c?.meta;
    return isRecord(meta) && typeof meta.name === "string" ? meta.name : undefined;
  };
  const parts = [nameOf(parent), nameOf(cmd)].filter((n): n is string => n !== undefined);
  const named = parts.join(" ");
  return named.startsWith("aai") ? named : `aai ${named}`.trim();
}

/**
 * Unknown flags in `argv` for whichever (possibly nested) subcommand it
 * selects — `[]` when everything is declared.
 *
 * Walks the real command tree rather than re-listing flags, so this cannot
 * drift from what the commands accept. An unknown SUBCOMMAND is not reported:
 * citty already answers that with usage text and a non-zero exit.
 */
export async function unknownFlagsForArgv(root: AnyCommandDef, argv: string[]): Promise<string[]> {
  let cmd: AnyCommandDef = root;
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || token.startsWith("-")) break;
    const subCommands = await resolve(cmd.subCommands);
    const next = subCommands?.[token];
    if (next === undefined) {
      // A non-flag token where this command expects a SUBCOMMAND means the
      // subcommand was mistyped. citty answers that with usage and exit 1;
      // adding "unknown flag" on top would blame the wrong token, since the
      // flags were being matched against the wrong command's definition.
      if (subCommands && Object.keys(subCommands).length > 0) return [];
      break;
    }
    const resolved = await resolve(next);
    if (resolved === undefined) break;
    cmd = resolved;
  }
  const argsDef = (await resolve(cmd.args)) ?? {};
  return findUnknownFlags(argv.slice(i), argsDef);
}

/** Shared command setup: resolve cwd, optionally require agent.ts. */
export async function setup(opts?: { agent?: boolean }): Promise<string> {
  const cwd = resolveCwd();
  if (opts?.agent) {
    const hasAgent = await fileExists(path.join(cwd, AGENT_ENTRY));
    if (!hasAgent) {
      throw new Error(`No ${AGENT_ENTRY} found in the current directory. Run \`aai init\` first.`);
    }
  }
  return cwd;
}

/**
 * Run a command body with standard output-mode resolution, error handling,
 * and result emission.
 *
 * - API key acquisition is owned by `resolveDeployTarget`/`getServerInfo`
 *   inside the commands that talk to the platform — after the server-trust
 *   check, so an untrusted `serverUrl` is refused without prompting for a
 *   key, and commands with no platform traffic never prompt at all.
 *
 * A thrown error and a returned `fail(...)` converge here on one emitter:
 * human mode logs the message and the hint, JSON mode writes exactly one
 * result line, and both exit 1.
 *
 * That convergence is the whole contract and it was HALF TRUE for a long
 * time: only the `catch` printed anything, so a body that RETURNED a failure
 * fell straight through to the JSON check and `process.exit(1)`. In human
 * mode that is a bare exit 1 with an empty terminal — `aai test` with no
 * runner binary on PATH (message and "is it on your PATH?" both discarded),
 * every `aai workflow` verb against a booting sandbox (the agent's own
 * sentence plus `HINT_BROKER` discarded), `aai secret put` with an empty
 * value, and `aai storage disable`'s "re-run with --force". Nine paths, all
 * silent. Emitting is therefore driven by the RESULT rather than by which
 * arm produced it.
 */
export async function runCommand(
  args: { json?: boolean | undefined },
  fn: (mode: OutputMode) => Promise<CommandResult<unknown>>,
): Promise<void> {
  const mode = getOutputMode(args);
  if (mode === "json") silenceOutput();
  let result: CommandResult<unknown>;
  try {
    result = await fn(mode);
  } catch (err: unknown) {
    const code = err instanceof CliError ? err.code : "command_failed";
    const hint = err instanceof CliError ? err.hint : undefined;
    result = fail(code, errorMessage(err), hint);
  }
  if (mode === "human" && !result.ok) {
    log.error(result.error);
    // The hint is the recovery step — it must reach the terminal, not just
    // the JSON result line (for a long time it reached machines only).
    if (result.hint) log.info(result.hint);
  }
  // Await the flush before exiting: on a pipe (the JSON-mode case) stdout is
  // async, so process.exit() would truncate the JSON line just queued.
  if (mode === "json") await writeLine(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
}

/**
 * What a command needs from the working directory, stated rather than
 * re-derived:
 *
 * - `"agent"` — an agent project. Refuses a directory with no `agent.ts`.
 * - `"any"` — the working directory, whatever is in it.
 * - `"none"` — no directory policy; the body resolves whatever it needs.
 */
export type CwdPolicy = "agent" | "any" | "none";

/** `undefined` under `"none"`, so a body cannot read a cwd it never asked for. */
type CwdFor<P extends CwdPolicy> = P extends "none" ? undefined : string;

/** Everything a command body gets, in one argument. */
export type ExecContext<T extends ArgsDef, P extends CwdPolicy> = {
  args: ParsedArgs<T>;
  mode: OutputMode;
  cwd: CwdFor<P>;
};

/**
 * `--json` as citty parsed it, or undefined when it was not passed.
 *
 * `Record<string, unknown>` because that is what a generic `ParsedArgs<T>`
 * satisfies: citty's parsed shape carries an index signature, and a parameter
 * typed `{ json?: boolean }` is a WEAK type, which TypeScript refuses an
 * argument whose known properties it cannot see through the generic.
 */
function jsonFlag(args: Record<string, unknown>): boolean | undefined {
  return typeof args.json === "boolean" ? args.json : undefined;
}

/**
 * The one place a {@link CwdPolicy} turns into a directory.
 *
 * The two casts are the conditional return type: TypeScript cannot verify a
 * `P extends "none" ? undefined : string` from inside a body generic in `P`,
 * and the runtime branch is the same test the type is. Callers get the exact
 * type, which is the point — a `"none"` body cannot read a `cwd`.
 */
async function resolvePolicyCwd<P extends CwdPolicy>(policy: P): Promise<CwdFor<P>> {
  if (policy === "none") return undefined as CwdFor<P>;
  return (await setup(policy === "agent" ? { agent: true } : undefined)) as CwdFor<P>;
}

/**
 * Define a citty command whose body is an EXECUTOR — the shape all
 * twenty-four of this CLI's leaf commands have.
 *
 * Written longhand, each one restates the same four lines (`async run({ args
 * })`, `await runCommand(args, async (mode) => …)`, a cwd resolution, a lazy
 * `await import`) and, in the middle of them, DECIDES the working-directory
 * policy — which is the part that is not boilerplate and the part that has
 * been wrong in production: `aai test` shipped calling `setup()` bare instead
 * of `setup({ agent: true })`, so in a directory with no `agent.ts` it found
 * no test file, reported `{ passed: true, skipped: true }` and exited 0. A
 * green result for a project that is not there reads, in CI, exactly like a
 * passing suite.
 *
 * `cwd` is a required field of the spec, so that decision is stated once per
 * command in the one place a reader looks for it, and "forgot to pass
 * `{ agent: true }`" stops being a representable mistake — the alternative
 * spelling is a policy name that does not exist.
 */
export function defineExec<const T extends ArgsDef, P extends CwdPolicy>(spec: {
  meta: CommandMeta;
  args: T;
  cwd: P;
  run: (ctx: ExecContext<T, P>) => Promise<CommandResult<unknown>>;
}): CommandDef<T> {
  return defineCommand<T>({
    meta: spec.meta,
    args: spec.args,
    async run({ args }) {
      await runCommand({ json: jsonFlag(args) }, async (mode) =>
        // Inside `runCommand`'s body, so the cwd policy's own failure ("No
        // agent.ts found…") converges on the same emitter as everything else
        // rather than escaping as an unhandled rejection.
        spec.run({ args, mode, cwd: await resolvePolicyCwd(spec.cwd) }),
      );
    },
  });
}
