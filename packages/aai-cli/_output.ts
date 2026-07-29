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
 * Wrap a command function to handle output formatting.
 *
 * - `fn` does the work and returns a `CommandResult<T>`. Human-readable
 *   output is printed inside `fn` itself.
 * - In JSON mode, writes exactly one JSON line to stdout.
 */
export async function withOutput<T>(
  mode: OutputMode,
  fn: () => Promise<CommandResult<T>>,
): Promise<void> {
  const result = await fn();
  // Await the flush before exiting: on a pipe (the JSON-mode case) stdout is
  // async, so process.exit() would truncate the JSON line just queued.
  if (mode === "json") await writeLine(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
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

/** Create an error result. */
export function fail<T>(code: string, error: string, hint?: string): CommandResult<T> {
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
