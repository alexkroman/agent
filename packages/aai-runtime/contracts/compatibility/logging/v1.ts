// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 template: `aai-runtime:logging`. The logger a host hands the runtime
 * and the ring buffer it reads back out, as a starter written at epoch 1 — copy
 * this file into your host and repoint the marked edit points.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so
 * `pnpm typecheck` is the backward-compatibility gate and an error here IS the
 * finding. Do not edit it to make an error go away: an API that has to change
 * gets a NEW epoch carrying a new template, never a change to this one. The
 * imports are relative source paths because nothing ships this file.
 *
 * Front to back: one ring buffer, the two sinks a child process's streams are
 * piped into, the {@link Logger} every runtime entry point takes, and the
 * cursor-paged reader that drains it. Both halves write into the SAME ring,
 * which is what puts the runtime's own lines and the agent's `console.log` in
 * one ordered stream.
 *
 * What to change:
 *
 * - {@link BUFFER_OPTIONS} — the whole capacity contract: how many lines
 *   survive, how wide a line may be before it is clipped, and how many one read
 *   may return.
 * - {@link LEVEL_FLOOR} — your deployment's floor. The runtime logs a non-fatal
 *   session error at DEBUG, so dropping debug lines is choosing not to see
 *   those.
 * - The `append` call inside {@link hostLogger} — point it at your own shipper,
 *   or call both it and the ring.
 *
 * What not to change, because both are load-bearing and neither shows up in a
 * type: {@link renderContext} must not throw (a context is arbitrary
 * structured data, and a logger that dies on an unserializable field takes the
 * process with it), and a one-shot read terminates by comparing its cursor
 * against `tail()` — see {@link drainLogs}.
 */

import {
  createLogBuffer,
  DEFAULT_LOG_BUFFER_LINES,
  DEFAULT_LOG_LINE_BYTES,
  DEFAULT_LOG_PAGE_LINES,
  LOG_LINE_TRUNCATED,
  type LogBuffer,
  type LogBufferOptions,
  type LogContext,
  type LogFn,
  type Logger,
  type LogLevel,
  type LogLine,
  type LogPage,
  type LogStream,
} from "../../../runtime-barrel.ts";

/** The capacity contract. ← change these */
export const BUFFER_OPTIONS: LogBufferOptions = {
  maxLines: DEFAULT_LOG_BUFFER_LINES,
  maxLineBytes: DEFAULT_LOG_LINE_BYTES,
  maxPageLines: DEFAULT_LOG_PAGE_LINES,
};

/** The least severe level this deployment keeps. ← change this */
export const LEVEL_FLOOR: LogLevel = "info";

/**
 * Which of the process's two streams each level is written to.
 *
 * A `Record` over {@link LogLevel} rather than a switch: the union is closed,
 * so a level added to it fails this declaration instead of falling through to a
 * default nobody chose.
 */
const STREAM_OF: Record<LogLevel, LogStream> = {
  debug: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
};

/** Least-to-most severe, so a floor can be compared by index. */
const SEVERITY: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** The ring this host holds for one agent process. */
export const buffer: LogBuffer = createLogBuffer(BUFFER_OPTIONS);

/**
 * A context is arbitrary structured data, so rendering it MUST NOT throw — a
 * cycle or a BigInt in one field is not a reason to lose the line, let alone
 * the process. Keep the catch.
 */
function renderContext(ctx: LogContext | undefined): string {
  if (ctx === undefined) return "";
  try {
    return ` ${JSON.stringify(ctx)}`;
  } catch {
    return " [uncontextualizable]";
  }
}

/**
 * The logger to hand `createRuntime`, `createAgentServer` and anything else
 * here that takes one.
 *
 * A {@link Logger} is a plain `Record<LogLevel, LogFn>` — four functions, no
 * class, no base to extend — so this is the whole implementation. The four are
 * built by one factory rather than written out, which keeps the level→stream
 * mapping and the formatting from drifting between them.
 */
export function hostLogger(target: LogBuffer, levelFloor: LogLevel = LEVEL_FLOOR): Logger {
  const floor = SEVERITY.indexOf(levelFloor);
  const at = (level: LogLevel): LogFn => {
    const stream = STREAM_OF[level];
    const enabled = SEVERITY.indexOf(level) >= floor;
    return (msg: string, ctx?: LogContext): void => {
      if (!enabled) return;
      // ← your sink: write to your shipper here instead of, or as well as, the ring.
      target.append(stream, `${level.toUpperCase()} ${msg}${renderContext(ctx)}\n`);
    };
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/**
 * The two sinks a child process's streams are piped into.
 *
 * Plain functions, because the buffer splits on newlines itself: a stream
 * delivers whatever the OS gave it, which both splits mid-line and coalesces
 * several lines into one write, and the ring is what makes every reader see the
 * same lines regardless of how the writes landed. Do not pre-split.
 */
export function captureSinks(target: LogBuffer): Record<LogStream, (chunk: string) => void> {
  return {
    stdout: (chunk: string) => target.append("stdout", chunk),
    stderr: (chunk: string) => target.append("stderr", chunk),
  };
}

/** What one line looks like once a pane, an SSE frame or a CLI has it. */
export function renderLine(line: LogLine): string {
  // A clipped line ends in this exact marker — the per-line cap is in BYTES, so
  // this is the only reliable way to know a line is incomplete.
  const clipped = line.text.endsWith(LOG_LINE_TRUNCATED) ? " [clipped]" : "";
  return `${new Date(line.at).toISOString()} ${line.stream}: ${line.text}${clipped}`;
}

/** One read's worth of output, plus where the next read resumes from. */
export type LogTail = {
  /** Pass as the next read's `after`. Never re-derive this from `lines.length`. */
  cursor: number;
  rendered: readonly string[];
  /** Non-zero means this reader fell behind the writer and lost lines. */
  missed: number;
};

/**
 * One read. `after` is the previous call's `cursor`; a first call passes `-1`
 * to start from the oldest line still held.
 *
 * Pass the cursor back rather than a line count: a count cannot survive
 * eviction, so two reads either side of a wrap agree on "500 lines seen" while
 * describing different lines. A page that returned nothing hands back the
 * caller's own cursor, so an idle poller holds its position instead of
 * rewinding to the start of the ring.
 *
 * `missed` is reported rather than swallowed. Eviction is the one failure a
 * reader cannot infer: a tail that silently skips is indistinguishable from an
 * agent that went quiet.
 */
export function readLogs(target: LogBuffer, after: number): LogTail {
  const page: LogPage = target.read(after, DEFAULT_LOG_PAGE_LINES);
  return { cursor: page.cursor, rendered: page.lines.map(renderLine), missed: page.dropped };
}

/**
 * Everything the ring holds from `after` on, in one call — a crash report, or
 * a `logs` command with no `--follow`.
 *
 * `tail()` is the highest seq assigned so far (`-1` for a ring nothing has
 * written to), and comparing the cursor against it is WHAT MAKES THIS
 * TERMINATE. A loop that instead stops on an empty page never finishes against
 * a live writer, and one that stops on a full page truncates. The
 * non-advancing-page break is the other half: without it a reader that somehow
 * cannot make progress spins here forever.
 */
export function drainLogs(target: LogBuffer, after = -1): LogTail {
  let cursor = after;
  const rendered: string[] = [];
  let missed = 0;
  while (cursor < target.tail()) {
    const page = readLogs(target, cursor);
    if (page.cursor === cursor) break;
    cursor = page.cursor;
    rendered.push(...page.rendered);
    missed += page.missed;
  }
  return { cursor, rendered, missed };
}

/**
 * Whether a live tail has caught up with the writer — the condition a poller
 * checks before deciding whether to sleep or read again.
 */
export function caughtUp(target: LogBuffer, cursor: number): boolean {
  return cursor >= target.tail();
}
