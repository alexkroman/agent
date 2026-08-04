// Copyright 2026 the AAI authors. MIT license.
// Shared plumbing for citty command definitions (cli.ts and
// _studio-commands.ts): common args, the working-directory setup, and the
// one output-mode/error/result emitter every command body runs under.

import path from "node:path";
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
