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
import * as clack from "@clack/prompts";
import { writeLine } from "./_output.ts";

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
  select: typeof clack.select;
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
  /** Write the JSON result line to stdout, resolving once flushed (ANSI stripped). */
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

/** The real terminal: clack for humans, `process.stdout`/`stderr` for the rest. */
export function createUi(): Ui {
  let silenced = false;
  const level =
    (name: LogLevel) =>
    (message: string): void => {
      if (!silenced) clack.log[name](message);
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
    process.stderr.write(`${line}\n`);
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
      confirm: clack.confirm,
      text: clack.text,
      password: clack.password,
      select: clack.select,
      spinner: () => (silenced ? { start: noop, stop: noop } : clack.spinner()),
      intro: (title) => {
        if (!silenced) clack.intro(title);
      },
      cancel: (message) => clack.cancel(message),
      isCancel: (value): value is symbol => clack.isCancel(value),
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
export function unwrapCancel<T>(ui: Ui, result: T | symbol, message = "Cancelled"): T {
  if (ui.prompts.isCancel(result)) {
    ui.prompts.cancel(message);
    process.exit(0);
  }
  return result as T;
}

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return styleText("cyanBright", url);
}

/**
 * Parse and validate a port string. Returns the numeric port or throws.
 * Zod-free for the startup-cost reason in the module doc.
 */
export function parsePort(raw: string): number {
  // `Number("")` is 0, so an empty/whitespace string must be rejected up front.
  const port = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
