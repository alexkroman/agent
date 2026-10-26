// Copyright 2025 the AAI authors. MIT license.
/**
 * The CLI's terminal seam: every human-facing line, every prompt and the one
 * JSON result line go through a {@link Ui}.
 *
 * A command never imports clack or writes to `process.stdout` itself; it is
 * handed a `Ui` (through `defineExec`'s context, or as its executor's last
 * parameter, defaulting to {@link defaultUi}). A spec passes
 * `createFakeUi()` from `_test-utils.ts` instead of `vi.mock("./_ui.ts")` or
 * `vi.mock("@clack/prompts")`, and reads what was said off the fake.
 *
 * Deliberately zod-free and light: this module loads on every invocation,
 * `aai --help` included.
 */

import { styleText } from "node:util";
import { omitUndefined } from "@alexkroman1/aai/utils";
import * as clack from "@clack/prompts";
import { CliError, sanitizeTerminalText, writeLine } from "./_output.ts";

/** The levels a command reports at. `message` is an unadorned line. */
export type LogLevel = "info" | "success" | "error" | "warn" | "step" | "message";

/** The levels {@link Ui.notify} accepts — the ones that mean something on stderr. */
export type NotifyLevel = "error" | "warn" | "info" | "success";

export type UiLog = Record<LogLevel, (message: string) => void>;

/** A spinner, as `aai init` drives one. */
export type UiSpinner = {
  start(message?: string): void;
  stop(message?: string): void;
};

/**
 * The interactive half. Each answer may be the cancel symbol; pass it through
 * {@link unwrapCancel}.
 */
export type UiPrompts = {
  confirm: typeof clack.confirm;
  text: typeof clack.text;
  password: typeof clack.password;
  /** A single choice among string values — the one shape `aai init` asks. */
  select(opts: {
    message: string;
    options: { value: string; label?: string; hint?: string }[];
    initialValue?: string;
    maxItems?: number;
  }): Promise<string | symbol>;
  spinner(): UiSpinner;
  intro(title: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): value is symbol;
};

export type Ui = {
  /** Human output. No-ops once {@link Ui.silence} has run (JSON mode). */
  readonly log: UiLog;
  /**
   * A message that must survive JSON mode: styled `log` in human mode, a plain
   * STDERR line once silenced. A LONG-RUNNING command (`aai dev`) writes its
   * one JSON line at startup and keeps running, and JSON mode is auto-selected
   * on a pipe (`aai dev > dev.log`), so every later failure goes through here.
   */
  notify(level: NotifyLevel, message: string): void;
  /** Switch to JSON mode: `log` goes quiet. Called once by `runCommand`. */
  silence(): void;
  /** Whether {@link Ui.silence} has run. */
  readonly silenced: boolean;
  /** Write the JSON result line (`resultLine`, `_output.ts`) to stdout, resolving once flushed. */
  writeResult(line: string): Promise<void>;
  /** Write one raw line to stdout — `--help`, never a result. */
  writeOut(line: string): void;
  /** Write one raw line to stderr. */
  writeErr(line: string): void;
  readonly prompts: UiPrompts;
};

const noop = () => {
  /* no-op */
};

/**
 * Terminal-safe text: every escape sequence but colour removed, other controls
 * rendered visibly (`sanitizeTerminalText`, `_output.ts`).
 *
 * Applied HERE, on every human path out of the real terminal, rather than at
 * the call sites: a project name from `aai list`, a server's error body, an
 * `aai logs` line, a workflow name all reach the terminal through this seam,
 * and any one call site that forgot would hand the server an OSC 52 clipboard
 * write or a screen clear. Colour survives because our own `styleText` output
 * is SGR.
 */
const safe = (text: string): string => sanitizeTerminalText(text, { keepSgr: true });

/** `opts` with its `message` made {@link safe} — the shape every clack prompt takes. */
function safeMessage<T extends { message: string }>(opts: T): T {
  return { ...opts, message: safe(opts.message) };
}

/** The clack calls {@link createUi} makes — a spec hands in a recorder. */
export type UiTerm = Pick<
  typeof clack,
  "log" | "confirm" | "text" | "password" | "select" | "intro" | "cancel" | "isCancel"
> & { spinner(): UiSpinner };

/**
 * The real terminal: clack for humans, `process.stdout`/`stderr` for the rest.
 * `term` is clack itself unless a spec passes a recorder (its namespace cannot
 * be spied on).
 */
export function createUi(term: UiTerm = clack): Ui {
  let silenced = false;
  const level =
    (name: LogLevel) =>
    (message: string): void => {
      if (!silenced) term.log[name](safe(message));
    };
  const log: UiLog = {
    info: level("info"),
    success: level("success"),
    error: level("error"),
    warn: level("warn"),
    step: level("step"),
    message: level("message"),
  };
  const writeErr = (line: string): void => {
    process.stderr.write(`${safe(line)}\n`);
  };
  return {
    log,
    notify(lvl, message) {
      if (silenced) writeErr(message);
      else log[lvl](message);
    },
    silence() {
      silenced = true;
    },
    get silenced() {
      return silenced;
    },
    writeResult: writeLine,
    writeOut: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeErr,
    prompts: {
      confirm: (opts) => term.confirm(safeMessage(opts)),
      text: (opts) => term.text(safeMessage(opts)),
      password: (opts) => term.password(safeMessage(opts)),
      // Option labels and hints too: `aai init`'s choices are template names.
      select: (opts) =>
        term.select({
          ...safeMessage(opts),
          options: opts.options.map((o) => ({
            ...o,
            ...omitUndefined({
              label: o.label === undefined ? undefined : safe(o.label),
              hint: o.hint === undefined ? undefined : safe(o.hint),
            }),
          })),
        }),
      spinner: () => {
        if (silenced) return { start: noop, stop: noop };
        const spin = term.spinner();
        return {
          start: (message) => spin.start(message === undefined ? undefined : safe(message)),
          stop: (message) => spin.stop(message === undefined ? undefined : safe(message)),
        };
      },
      intro: (title) => {
        if (!silenced) term.intro(safe(title));
      },
      cancel: (message) => term.cancel(safe(message)),
      isCancel: (value): value is symbol => term.isCancel(value),
    },
  };
}

/**
 * The process's one real {@link Ui}. `defineExec` hands it to every command
 * body; an executor's `ui` parameter defaults to it. Nothing else should
 * reach for it — take a `Ui` instead.
 */
export const defaultUi: Ui = createUi();

/**
 * Unwrap a prompt result, exiting cleanly if the user cancelled.
 * `message` lets the caller name what was cancelled (e.g. "Setup cancelled").
 */
export function unwrapCancel<T>(ui: Ui, result: T, message = "Cancelled"): Exclude<T, symbol> {
  if (ui.prompts.isCancel(result)) {
    ui.prompts.cancel(message);
    process.exit(0);
  }
  return result as Exclude<T, symbol>;
}

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return styleText("cyanBright", url);
}

/**
 * A flag value as a whole number in `[min, max]`, or `undefined` when it is
 * not one — DECIMAL DIGITS ONLY.
 *
 * `Number()` is not a parser for this: it reads `0x10` as 16, `1e3` as 1000,
 * `""`/`"  "` as 0 and `1.0` as 1, so `--port 0x10` bound port 16 and
 * `--limit ""` asked for zero runs, each without a word.
 */
export function parseDecimalInt(raw: string, min: number, max: number): number | undefined {
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Parse and validate a port string. Returns the numeric port or throws.
 * Zod-free for the startup-cost reason in the module doc.
 *
 * 1–65535: no command here documents port 0 ("any free port"), and both
 * `aai dev` and `aai start` print the port they were given.
 */
export function parsePort(raw: string): number {
  const port = parseDecimalInt(raw, 1, 65_535);
  if (port === undefined) {
    throw new CliError(
      "usage",
      `Invalid port: ${raw}. Must be a whole number from 1 to 65535.`,
      "Pass --port as plain decimal digits, e.g. --port 3000.",
    );
  }
  return port;
}
