// Copyright 2026 the AAI authors. MIT license.
/**
 * A bounded, cursor-indexed ring of log lines.
 *
 * The gap it closes: a guest's `console.log` went to its stdout, the platform
 * relayed that stdout into its OWN log (`aai-server/warm-harness.ts`,
 * `startGuestLogging`), and there it stopped. An operator could read it in
 * Modal; the person who wrote the tool could not read it anywhere. This is the
 * store that makes it readable — held BY THE GUEST, because a guest's stdout is
 * the one thing only the guest is guaranteed to have (see
 * "Why the buffer lives in the guest" in `packages/aai-guest/CLAUDE.md`).
 *
 * Three properties are what the readers need, and each is a decision:
 *
 * - **`seq` is monotonic and never reused**, so a tailing reader passes back the
 *   cursor it was handed rather than a line count. A count cannot survive
 *   eviction: two reads either side of a wrap would agree on "500 lines seen"
 *   while describing different lines.
 * - **Eviction is REPORTED, not silent.** {@link LogPage.dropped} says how many
 *   lines fell out of the ring between the caller's cursor and the oldest line
 *   still held. A tail that silently skips is indistinguishable from an agent
 *   that went quiet, which is the one reading a log must never be ambiguous
 *   about.
 * - **Lines, not chunks.** A stream hands over whatever the OS gave it, which
 *   splits mid-line and coalesces several lines into one write. Splitting here
 *   means every reader gets the same lines regardless of how the writes landed.
 *
 * @module
 */

import { pushCapped } from "@alexkroman1/aai/utils";

/** Which of a process's two streams a line came from. */
export type LogStream = "stdout" | "stderr";

/** One captured line. */
export type LogLine = {
  /** Monotonic position, assigned on append. Never reused, never re-ordered. */
  seq: number;
  /** Epoch milliseconds at append. */
  at: number;
  stream: LogStream;
  /** The line, newline stripped, truncated to the buffer's per-line cap. */
  text: string;
};

/** One read. */
export type LogPage = {
  lines: LogLine[];
  /**
   * Pass as the next read's `after`. Equal to the last line's `seq`, or to the
   * caller's own `after` when nothing was returned — so an idle tail keeps its
   * position instead of rewinding to the start of the ring.
   */
  cursor: number;
  /**
   * Lines evicted between the caller's cursor and the oldest line still held.
   * Non-zero means the reader fell behind the writer.
   */
  dropped: number;
};

export type LogBuffer = {
  /**
   * Add whatever a stream just produced. Split on `\n`; a trailing fragment is
   * held until its newline arrives (or until it outgrows the per-line cap).
   */
  append(stream: LogStream, chunk: string): void;
  /** Lines after `after` (exclusive). `after < 0` reads from the oldest held. */
  read(after?: number, limit?: number): LogPage;
  /** Highest seq assigned so far; `-1` when nothing has been appended. */
  tail(): number;
};

export type LogBufferOptions = {
  /** Lines retained before the oldest is evicted. */
  maxLines?: number;
  /** Bytes one line may hold before it is truncated. */
  maxLineBytes?: number;
  /** Lines one {@link LogBuffer.read} may return. */
  maxPageLines?: number;
  /** Clock seam for tests. */
  now?: () => number;
};

/**
 * 2,000 lines: enough that a boot plus a few turns fits, small enough that the
 * whole ring serialises well under the platform's response budget even with
 * every line at the cap below. At 4 KiB × 2,000 the worst case is 8 MiB held
 * per guest, which only a guest deliberately spewing reaches.
 */
export const DEFAULT_LOG_BUFFER_LINES = 2000;

/**
 * 4 KiB per line. A stack trace fits; a base64 blob someone logged by accident
 * does not, and truncating it is the point — one such line would otherwise
 * evict the entire ring.
 */
export const DEFAULT_LOG_LINE_BYTES = 4096;

/** Lines one read returns unless the caller asks for fewer. */
export const DEFAULT_LOG_PAGE_LINES = 500;

/** Appended to a line cut at {@link LogBufferOptions.maxLineBytes}. */
export const LOG_LINE_TRUNCATED = "… [truncated]";

export function createLogBuffer(options: LogBufferOptions = {}): LogBuffer {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_LOG_BUFFER_LINES);
  const maxLineBytes = Math.max(16, options.maxLineBytes ?? DEFAULT_LOG_LINE_BYTES);
  const maxPageLines = Math.max(1, options.maxPageLines ?? DEFAULT_LOG_PAGE_LINES);
  const now = options.now ?? Date.now;

  const lines: LogLine[] = [];
  /** Next seq to assign. `lines[0].seq` is `nextSeq - lines.length` while full. */
  let nextSeq = 0;
  /** Per-stream carry: bytes written without a terminating newline yet. */
  const pending: Record<LogStream, string> = { stdout: "", stderr: "" };

  const push = (stream: LogStream, raw: string): void => {
    // `\r` is stripped rather than treated as a separator: a CRLF writer would
    // otherwise leave a trailing carriage return on every line, which renders
    // as a stray glyph in the pane and breaks equality in tests.
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    pushCapped(
      lines,
      {
        seq: nextSeq++,
        at: now(),
        stream,
        text: text.length > maxLineBytes ? text.slice(0, maxLineBytes) + LOG_LINE_TRUNCATED : text,
      },
      maxLines,
    );
  };

  return {
    append(stream, chunk) {
      if (chunk === "") return;
      const parts = (pending[stream] + chunk).split("\n");
      // The last part has no newline after it, so it is the new carry.
      pending[stream] = parts.pop() ?? "";
      for (const part of parts) push(stream, part);
      // A writer that never emits a newline would otherwise grow the carry
      // without bound and show the reader nothing. Cut it loose at the cap.
      if (pending[stream].length > maxLineBytes) {
        push(stream, pending[stream]);
        pending[stream] = "";
      }
    },

    read(after = -1, limit = maxPageLines) {
      const oldest = lines[0]?.seq ?? nextSeq;
      // A cursor older than the ring means the reader fell behind. Count what
      // it missed BEFORE clamping, or the gap reports as zero.
      const dropped = after + 1 < oldest ? oldest - (after + 1) : 0;
      const take = Math.min(Math.max(1, limit), maxPageLines);
      const page = lines.filter((line) => line.seq > after).slice(0, take);
      return {
        lines: page,
        // Hold the caller's position when the page is empty: rewinding to
        // `oldest` would replay the whole ring on every idle poll.
        cursor: page.at(-1)?.seq ?? Math.max(after, oldest - 1),
        dropped,
      };
    },

    tail() {
      return nextSeq - 1;
    },
  };
}
