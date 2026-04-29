// Copyright 2025 the AAI authors. MIT license.

export type OutputMode = "json" | "human";

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; hint?: string };

export function getOutputMode(
  args: { json?: boolean | undefined },
  isTTY = Boolean(process.stdout.isTTY),
): OutputMode {
  if (args.json === true) return "json";
  if (args.json === false) return "human";
  return isTTY ? "human" : "json";
}

export async function withOutput<T>(
  mode: OutputMode,
  fn: () => Promise<CommandResult<T>>,
  humanRender: (result: CommandResult<T>) => void,
): Promise<void> {
  const result = await fn();
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    humanRender(result);
  }
  if (!result.ok) process.exit(1);
}

export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data };
}

export function fail<T>(code: string, error: string, hint?: string): CommandResult<T> {
  return hint ? { ok: false, error, code, hint } : { ok: false, error, code };
}

export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }
}
