// Copyright 2025 the AAI authors. MIT license.

/**
 * Structured output support for CLI commands.
 *
 * In JSON mode (non-TTY or --json), commands emit exactly one JSON line to
 * stdout. In human mode (TTY, default), commands use @clack/prompts as before.
 */

import { isRecord } from "@alexkroman1/aai/utils";

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

const ESC = 0x1b;
const BEL = 0x07;

/** `ESC ]`, `ESC P`, `ESC X`, `ESC ^`, `ESC _`: sequences that run to a terminator. */
const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);

/** A control character no terminal-bound text may carry raw — all but `\n` and `\t`. */
function isUnsafeControl(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** `\x1b` for ESC — a stray control character, rendered as text a terminal prints. */
function visible(code: number): string {
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

/** Whether `code` is in the inclusive range `[lo, hi]`. */
function inRange(code: number, lo: number, hi: number): boolean {
  return code >= lo && code <= hi;
}

/**
 * The end (exclusive) of the escape sequence whose ESC is at `text[at]`, and
 * whether it is an SGR colour sequence — or `undefined` when the ESC starts
 * nothing complete, in which case it is a stray byte.
 */
function escapeSequenceAt(text: string, at: number): { end: number; sgr: boolean } | undefined {
  const next = text[at + 1];
  if (next === undefined) return undefined;
  if (next === "[") return csiAt(text, at);
  if (STRING_INTRODUCERS.has(next)) return { end: stringSequenceEnd(text, at), sgr: false };
  // nF (`ESC ( B`) and the two-byte forms (`ESC 7`, `ESC c` — a full RESET).
  const i = skipRange(text, at + 1, 0x20, 0x2f);
  return inRange(text.charCodeAt(i), 0x30, 0x7e) ? { end: i + 1, sgr: false } : undefined;
}

/** The first index from `from` whose code unit is outside `[lo, hi]`. */
function skipRange(text: string, from: number, lo: number, hi: number): number {
  let i = from;
  while (inRange(text.charCodeAt(i), lo, hi)) i++;
  return i;
}

/** CSI: parameter bytes 0x30–0x3F, intermediates 0x20–0x2F, one final 0x40–0x7E. */
function csiAt(text: string, at: number): { end: number; sgr: boolean } | undefined {
  const paramsEnd = skipRange(text, at + 2, 0x30, 0x3f);
  const i = skipRange(text, paramsEnd, 0x20, 0x2f);
  if (!inRange(text.charCodeAt(i), 0x40, 0x7e)) return undefined;
  const sgr = text[i] === "m" && i === paramsEnd && /^[\d;:]*$/.test(text.slice(at + 2, i));
  return { end: i + 1, sgr };
}

/**
 * OSC/DCS/SOS/PM/APC run to BEL or ST (`ESC \`). An unterminated one ends at
 * the end of the text: a terminal would swallow everything after it anyway.
 */
function stringSequenceEnd(text: string, at: number): number {
  for (let i = at + 2; i < text.length; i++) {
    if (text.charCodeAt(i) === BEL) return i + 1;
    if (text.charCodeAt(i) === ESC && text[i + 1] === "\\") return i + 2;
  }
  return text.length;
}

/**
 * Make text that came from somewhere else safe to put on a terminal.
 *
 * Server- and agent-supplied strings (an `aai list` project name, an error
 * body, a log line) reach the terminal through this CLI, and a raw one can do
 * anything the terminal can: OSC 52 writes the clipboard, `ESC [2J` clears the
 * screen, OSC 8 disguises a link, OSC 0 retitles the window, `ESC c` resets it.
 * So EVERY escape sequence is removed — CSI, OSC, the other string forms and
 * the two-byte ones — except SGR colour when `keepSgr` (our own `styleText`
 * output is SGR), and every other C0/C1 control but `\n` and `\t` is rendered
 * visibly as `\xNN` rather than passed through. `\r\n` becomes `\n`.
 *
 * A hand-written walk rather than a regex: Biome's `noControlCharactersInRegex`
 * refuses the pattern (see `aai-runtime`'s `typed-json-escape.ts` for the same
 * call).
 */
export function sanitizeTerminalText(text: string, opts: { keepSgr: boolean }): string {
  let out = "";
  let copied = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) {
      out += text.slice(copied, at);
      copied = at + 1;
      continue;
    }
    const seq = code === ESC ? escapeSequenceAt(text, at) : undefined;
    if (seq !== undefined) {
      out += text.slice(copied, at) + (opts.keepSgr && seq.sgr ? text.slice(at, seq.end) : "");
      copied = seq.end;
      at = seq.end - 1;
      continue;
    }
    if (!isUnsafeControl(code)) continue;
    out += text.slice(copied, at) + visible(code);
    copied = at + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * {@link sanitizeTerminalText} with colour removed too — for human text that
 * is not headed for a styled terminal (a JSON result's sentences).
 *
 * A bundler colours its own diagnostics unconditionally, so `aai build`'s
 * failure reached the JSON envelope as per-character SGR pairs — illegible in a
 * CI log and meaningless to a `jq` consumer, which is the audience JSON mode
 * has.
 */
export function stripAnsi(text: string): string {
  return sanitizeTerminalText(text, { keepSgr: false });
}

/**
 * The JSON result line for `result`, newline-terminated.
 *
 * Only the HUMAN-TEXT fields are cleaned (`error`, `hint`, `data.warnings`),
 * by {@link stripAnsi}: they are sentences a `jq -r` prints to a terminal, and
 * a diagnostic or a server's error body can carry colour or an OSC 52. DATA is
 * emitted verbatim (JSON-escaped): stripping the whole serialized line used to
 * rewrite it, so `aai init $'\e[31mred'` reported a `dir` ending `/red` while
 * it created a directory whose name holds the ESC byte — and missed OSC, which
 * `jq -r` then handed the terminal.
 */
export function resultLine(result: CommandResult<unknown>): string {
  return `${JSON.stringify(cleanHumanFields(result))}\n`;
}

function cleanHumanFields(result: CommandResult<unknown>): CommandResult<unknown> {
  if (!result.ok) {
    const { error, code, hint } = result;
    return fail(code, stripAnsi(error), hint === undefined ? undefined : stripAnsi(hint));
  }
  const { data } = result;
  if (!isRecord(data)) return result;
  const { warnings } = data;
  if (!Array.isArray(warnings)) return result;
  const cleaned = warnings.map((w: unknown) => (typeof w === "string" ? stripAnsi(w) : w));
  return { ok: true, data: { ...data, warnings: cleaned } };
}

/**
 * Write a machine-readable line to stdout, resolving only once it has been
 * flushed. The line goes out VERBATIM — build it with {@link resultLine},
 * which cleans the human-text fields and leaves data alone.
 *
 * Resolves (never rejects) even when the write fails: the common failure is
 * EPIPE — the consumer closed the pipe (`aai … --json | head -1`) — and the
 * exit code owed then is {@link installStdoutGuard}'s to deliver.
 */
export function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(line, () => resolve());
  });
}

let owedExitCode: number | undefined;

/**
 * Record the exit code this run owes, BEFORE writing the output that settles
 * it — `runCommand` from its result, `--help` and `--version` as 0 — so a
 * reader that has already gone (EPIPE) still gets the right code from
 * {@link installStdoutGuard}. Module state rather than `process.exitCode`,
 * which a spec running `runCommand` in the test process would inherit.
 */
export function oweExitCode(code: number | undefined): void {
  owedExitCode = code;
}

/**
 * Install an `'error'` listener on stdout so a broken pipe doesn't crash the
 * CLI with an unhandled `'error'` event. EPIPE (consumer went away, e.g.
 * `aai … --json | head -1`) exits quietly WITH THE CODE THE RUN OWES — what
 * {@link oweExitCode} last recorded, else 1 (nothing has succeeded yet). It
 * used to be a flat `exit(0)`, so a failing `aai list | <closed>` passed under
 * `pipefail`. Anything else is reported on stderr and exits 1.
 */
export function installStdoutGuard(stream: NodeJS.EventEmitter = process.stdout): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(owedExitCode ?? 1);
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
