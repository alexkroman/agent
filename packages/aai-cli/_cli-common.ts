// Copyright 2026 the AAI authors. MIT license.
// Shared plumbing for citty command definitions (cli.ts and
// _studio-commands.ts): common args, the working-directory setup, and the
// one output-mode/error/result emitter every command body runs under.

import path from "node:path";
import type { ArgsDef, CommandDef, Resolvable } from "citty";
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
    // `--no-force` is citty's negation of the `force` boolean.
    if (token && !declared.has(token.replace(/^--?/, "").replace(/^no-/, ""))) unknown.push(token);
  }
  return unknown;
}

/** Every flag name and alias `argsDef` declares, plus citty's built-ins. */
function declaredFlagNames(argsDef: ArgsDef): Set<string> {
  const declared = new Set(BUILTIN_FLAGS);
  for (const [name, def] of Object.entries(argsDef)) {
    const { type, alias } = def as { type?: string; alias?: string | string[] };
    if (type === "positional") continue;
    declared.add(name);
    if (typeof alias === "string") declared.add(alias);
    else if (Array.isArray(alias)) for (const a of alias) declared.add(a);
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
 * human mode logs the message, JSON mode writes exactly one result line,
 * and both exit 1.
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
    if (mode === "human") {
      log.error(errorMessage(err));
      // The hint is the recovery step — it must reach the terminal, not just
      // the JSON result line (for a long time it reached machines only).
      if (hint) log.info(hint);
    }
    result = fail(code, errorMessage(err), hint);
  }
  // Await the flush before exiting: on a pipe (the JSON-mode case) stdout is
  // async, so process.exit() would truncate the JSON line just queued.
  if (mode === "json") await writeLine(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
}
