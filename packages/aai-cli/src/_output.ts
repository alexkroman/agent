// Copyright 2025 the AAI authors. MIT license.

/**
 * Structured output support for CLI commands.
 *
 * In JSON mode (non-TTY or --json), commands emit exactly one JSON line to
 * stdout. In human mode (TTY, default), commands use @clack/prompts as before.
 */

import { stripVTControlCharacters } from "node:util";

export type OutputMode = "json" | "human";

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; hint?: string };

/**
 * Determine output mode from CLI flags and TTY state.
 *
 * Priority: --json flag > --no-json flag > TTY auto-detection.
 */
export function getOutputMode(
  args: { json?: boolean | undefined },
  isTTY = Boolean(process.stdout.isTTY),
): OutputMode {
  if (args.json === true) return "json";
  if (args.json === false) return "human";
  return isTTY ? "human" : "json";
}

/**
 * A terminal escape sequence AFTER `JSON.stringify`, which escapes the ESC
 * byte as the six characters `\u001b`. Needed alongside the raw form because a
 * caller stringifies a whole result and hands the line here — see
 * {@link writeLine} — and no builtin reads that spelling.
 */
const ANSI_JSON = /\\u001[bB]\[[0-?]*[ -/]*[@-~]/g;

/**
 * Remove ANSI escape sequences, in raw or JSON-escaped form.
 *
 * A bundler colours its own diagnostics unconditionally, so `aai build`'s
 * failure reached the JSON envelope as per-character SGR pairs — illegible in a
 * CI log and meaningless to a `jq` consumer, which is the audience JSON mode
 * has.
 *
 * The raw half is `node:util`'s, not a local CSI regex. A/B'd on Node 26: the
 * two agree on every SGR pair and cursor move the hand-built pattern was
 * written for, and the builtin ALSO strips OSC-8 hyperlinks (`ESC ] 8 ;; url`)
 * and charset selects (`ESC ( B`), which that pattern left in the envelope — so
 * its claim to cover what a diagnostic arrives wearing was the incomplete part.
 * The JSON-escaped half has no builtin and stays.
 */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text).replace(ANSI_JSON, "");
}

/**
 * Write a machine-readable line to stdout, resolving only once it has been
 * flushed.
 *
 * ANSI escapes are stripped on the way out. This function carries JSON mode's
 * one result line and nothing else — human output goes through `log.*` in
 * `_ui.ts`, which is where colour belongs — so stripping here is what keeps
 * the envelope clean no matter which module built the string inside it, and
 * leaves a TTY's coloured diagnostic intact.
 *
 * Resolves (never rejects) even when the write fails: the common failure is
 * EPIPE — the consumer closed the pipe (`aai … --json | head -1`) — and there
 * is nothing useful to do about a broken stdout except carry on and exit.
 * Stream-level `'error'` events are handled by {@link installStdoutGuard}.
 */
export function writeLine(line: string): Promise<void> {
  const clean = stripAnsi(line);
  return new Promise((resolve) => {
    process.stdout.write(clean, () => resolve());
  });
}

/**
 * Install an `'error'` listener on stdout so a broken pipe doesn't crash the
 * CLI with an unhandled `'error'` event. EPIPE (consumer went away, e.g.
 * `aai … --json | head -1`) exits quietly; anything else is reported on
 * stderr and exits non-zero.
 */
export function installStdoutGuard(stream: NodeJS.WriteStream = process.stdout): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(0);
    } else {
      process.stderr.write(`stdout error: ${err.message}\n`);
      process.exit(1);
    }
  });
}

/** Create an ok result. */
export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data };
}

/**
 * Create an error result.
 *
 * `CommandResult<never>`, not `CommandResult<T>`: a failure carries no `data`,
 * so the parameter was inferred as `unknown` at all ten call sites and named
 * a type this value can never hold. `never` widens into any `CommandResult<T>`
 * the caller declares, so `return fail(...)` still type-checks everywhere.
 */
export function fail(code: string, error: string, hint?: string): CommandResult<never> {
  return hint ? { ok: false, error, code, hint } : { ok: false, error, code };
}

/** Typed CLI error that carries a structured error code and optional hint. */
export class CliError extends Error {
  readonly code: string;
  readonly hint?: string | undefined;

  constructor(code: string, message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}
