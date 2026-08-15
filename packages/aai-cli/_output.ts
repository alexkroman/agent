// Copyright 2025 the AAI authors. MIT license.

/**
 * Structured output support for CLI commands.
 *
 * In JSON mode (non-TTY or --json), commands emit exactly one JSON line to
 * stdout. In human mode (TTY, default), commands use @clack/prompts as before.
 */

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
 * Write a line to stdout, resolving only once it has been flushed.
 *
 * Resolves (never rejects) even when the write fails: the common failure is
 * EPIPE — the consumer closed the pipe (`aai … --json | head -1`) — and there
 * is nothing useful to do about a broken stdout except carry on and exit.
 * Stream-level `'error'` events are handled by {@link installStdoutGuard}.
 */
export function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(line, () => resolve());
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
