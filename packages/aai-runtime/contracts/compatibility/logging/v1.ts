// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:logging` epoch 1.
 *
 * What "frozen" obliges is one thing only: this file must keep COMPILING
 * against current source for as long as epoch 1 is advertised as retained, so
 * `pnpm typecheck` — not a claim in a changelog — is the backward-compatibility
 * gate. An error here IS the finding; editing the example to make it go away
 * defeats the whole mechanism. The imports are relative source paths because
 * nothing ships this file and the package's own npm name does not resolve from
 * inside it.
 *
 * Logging has two halves and an embedder touches both, so both are here:
 *
 * - **{@link Logger} is implemented, not obtained.** Every runtime entry point
 *   (`createRuntime`, `createAgentServer`, `createWorkflowClient`, …) takes one,
 *   and it is a plain `Record<LogLevel, LogFn>` — four functions, no class, no
 *   base to extend — precisely so a host can hand over whatever it already
 *   writes lines with. The one below writes into the ring buffer beside it,
 *   which is what puts the runtime's own lines and the agent's `console.log` in
 *   ONE ordered stream; a host that already has a log shipper points these four
 *   functions at that instead.
 * - **{@link LogBuffer} is PAGED, by cursor.** A deployment reads a sandbox's
 *   output back out of it — the guest holds the ring, because a guest's stdout
 *   is the one thing only the guest is guaranteed to have — and the reader is
 *   always a poller: it passes back the `cursor` it was handed rather than a
 *   line count, because a count cannot survive eviction. Two reads either side
 *   of a wrap agree on "500 lines seen" while describing different lines.
 *
 * The property that shapes the reader below is that **eviction is reported**:
 * {@link LogPage.dropped} is how many lines fell out between the caller's
 * cursor and the oldest line still held, and a tail that silently skips is
 * indistinguishable from an agent that went quiet. So a reader surfaces it
 * rather than treating a page as just its lines.
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

/**
 * Which of the process's two streams each level is written to.
 *
 * A `Record` over {@link LogLevel} rather than a switch: the level union is
 * closed, so a level added to it fails this declaration instead of falling
 * through to a default nobody chose.
 */
const STREAM_OF: Record<LogLevel, LogStream> = {
  debug: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
};

/** Least-to-most severe, so a floor can be compared by index. */
const SEVERITY: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * The ring a harness holds for one sandbox.
 *
 * Spelled out with the shipped defaults rather than passing `{}`, because these
 * three numbers are the whole capacity contract — how many lines survive, how
 * wide a line may be before it is clipped, and how many one read may return —
 * and a deployment that wants a bigger window is editing exactly this.
 */
export const BUFFER_OPTIONS: LogBufferOptions = {
  maxLines: DEFAULT_LOG_BUFFER_LINES,
  maxLineBytes: DEFAULT_LOG_LINE_BYTES,
  maxPageLines: DEFAULT_LOG_PAGE_LINES,
};

/** The buffer the rest of this example writes into and reads out of. */
export const buffer: LogBuffer = createLogBuffer(BUFFER_OPTIONS);

/** A context is arbitrary structured data, so rendering it must not throw. */
function renderContext(ctx: LogContext | undefined): string {
  if (ctx === undefined) return "";
  try {
    return ` ${JSON.stringify(ctx)}`;
  } catch {
    return " [uncontextualizable]";
  }
}

/**
 * A {@link Logger} that appends into a {@link LogBuffer}.
 *
 * `levelFloor` is the host's, not the runtime's: the runtime logs a non-fatal
 * session error at DEBUG, so a deployment that drops debug lines is choosing
 * not to see those. The four functions are built by one factory rather than
 * written out, which is what keeps the level→stream mapping and the formatting
 * from drifting between them.
 */
export function bufferLogger(target: LogBuffer, levelFloor: LogLevel = "info"): Logger {
  const floor = SEVERITY.indexOf(levelFloor);
  const at = (level: LogLevel): LogFn => {
    const stream = STREAM_OF[level];
    const enabled = SEVERITY.indexOf(level) >= floor;
    return (msg: string, ctx?: LogContext): void => {
      if (!enabled) return;
      target.append(stream, `${level.toUpperCase()} ${msg}${renderContext(ctx)}\n`);
    };
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** What one line looks like once a pane, an SSE frame or a CLI has it. */
export function renderLine(line: LogLine): string {
  // A clipped line ends in this exact marker — the buffer's per-line cap is in
  // BYTES, so this is the only reliable way to know a line is incomplete.
  const clipped = line.text.endsWith(LOG_LINE_TRUNCATED)
    ? " [see the full line in the source]"
    : "";
  return `${new Date(line.at).toISOString()} ${line.stream}: ${line.text}${clipped}`;
}

/** One poll's worth of output, plus where the next poll resumes from. */
export type LogTail = {
  /** Pass as the next read's `after`. Never re-derived from `lines.length`. */
  cursor: number;
  rendered: readonly string[];
  /** Non-zero means this reader fell behind the writer and lost lines. */
  missed: number;
};

/**
 * One poll.
 *
 * `after` is the previous call's `cursor`, and a first call passes `-1` to read
 * from the oldest line still held. A page that returned nothing hands back the
 * caller's own cursor, so an idle tail holds its position rather than rewinding
 * to the start of the ring.
 */
export function pollLogs(target: LogBuffer, after: number): LogTail {
  const page: LogPage = target.read(after, DEFAULT_LOG_PAGE_LINES);
  return {
    cursor: page.cursor,
    rendered: page.lines.map(renderLine),
    missed: page.dropped,
  };
}

/**
 * Whether a reader has caught up with the writer.
 *
 * `tail()` is the highest seq assigned so far (`-1` for a buffer nothing has
 * written to), which is what lets a one-shot read — `aai logs` without
 * `--follow`, a crash report — know it is done rather than polling forever.
 */
export function caughtUp(target: LogBuffer, cursor: number): boolean {
  return cursor >= target.tail();
}

/**
 * The two sinks a child process's streams are piped into.
 *
 * Handed out as plain functions, because the buffer splits on newlines itself:
 * a stream delivers whatever the OS gave it, which both splits mid-line and
 * coalesces several lines into one write, and the ring is what makes every
 * reader see the same lines regardless of how the writes landed.
 */
export function captureSinks(target: LogBuffer): Record<LogStream, (chunk: string) => void> {
  return {
    stdout: (chunk: string) => target.append("stdout", chunk),
    stderr: (chunk: string) => target.append("stderr", chunk),
  };
}
