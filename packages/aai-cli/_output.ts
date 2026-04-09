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
 * - `fn` does the work and returns a `CommandResult<T>`. It must not print.
 * - `humanRender` formats the result for human-readable TTY output.
 * - In JSON mode, writes exactly one JSON line to stdout.
 */
export async function withOutput<T>(
  mode: OutputMode,
  fn: () => Promise<CommandResult<T>>,
  humanRender: (result: CommandResult<T>) => void,
): Promise<void> {
  const result = await fn();
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exit(1);
  } else {
    humanRender(result);
    if (!result.ok) process.exit(1);
  }
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

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}
