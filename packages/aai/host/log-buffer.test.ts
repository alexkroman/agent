// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  createLogBuffer,
  DEFAULT_LOG_PAGE_LINES,
  LOG_LINE_TRUNCATED,
  type LogLine,
} from "./log-buffer.ts";

const texts = (lines: readonly LogLine[]) => lines.map((l) => l.text);

describe("createLogBuffer", () => {
  test("splits a chunk into newline-delimited lines", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "one\ntwo\nthree\n");
    expect(texts(buf.read().lines)).toEqual(["one", "two", "three"]);
  });

  test("holds a trailing fragment until its newline arrives", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "half");
    expect(buf.read().lines).toEqual([]);
    buf.append("stdout", "-line\n");
    expect(texts(buf.read().lines)).toEqual(["half-line"]);
  });

  test("keeps each stream's fragment separate", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "out-");
    buf.append("stderr", "err-");
    buf.append("stdout", "a\n");
    buf.append("stderr", "b\n");
    expect(buf.read().lines).toEqual([
      expect.objectContaining({ stream: "stdout", text: "out-a" }),
      expect.objectContaining({ stream: "stderr", text: "err-b" }),
    ]);
  });

  test("strips a CRLF writer's carriage return", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "windows\r\n");
    expect(texts(buf.read().lines)).toEqual(["windows"]);
  });

  test("assigns monotonic seqs a reader can page by", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "a\nb\nc\n");
    const first = buf.read(-1, 2);
    expect(texts(first.lines)).toEqual(["a", "b"]);
    expect(first.cursor).toBe(1);
    const second = buf.read(first.cursor);
    expect(texts(second.lines)).toEqual(["c"]);
    expect(second.cursor).toBe(2);
  });

  test("an empty page holds the caller's cursor rather than rewinding", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "a\nb\n");
    const caught = buf.read();
    const idle = buf.read(caught.cursor);
    expect(idle.lines).toEqual([]);
    expect(idle.cursor).toBe(caught.cursor);
    expect(idle.dropped).toBe(0);
  });

  test("evicts oldest first and reports the gap to a reader that fell behind", () => {
    const buf = createLogBuffer({ maxLines: 3 });
    buf.append("stdout", "1\n2\n");
    const behind = buf.read();
    buf.append("stdout", "3\n4\n5\n6\n");
    const caught = buf.read(behind.cursor);
    // Ring holds 4,5,6; the reader's cursor was at 2 (seq 1), so 3 was lost.
    expect(texts(caught.lines)).toEqual(["4", "5", "6"]);
    expect(caught.dropped).toBe(1);
  });

  test("reports no gap for a reader that is still inside the ring", () => {
    const buf = createLogBuffer({ maxLines: 5 });
    buf.append("stdout", "1\n2\n3\n");
    const page = buf.read(0);
    expect(texts(page.lines)).toEqual(["2", "3"]);
    expect(page.dropped).toBe(0);
  });

  test("a fresh reader of an already-wrapped ring is told what it missed", () => {
    const buf = createLogBuffer({ maxLines: 2 });
    buf.append("stdout", "1\n2\n3\n4\n");
    const page = buf.read();
    expect(texts(page.lines)).toEqual(["3", "4"]);
    expect(page.dropped).toBe(2);
  });

  test("truncates a line past the per-line cap instead of letting it evict the ring", () => {
    const buf = createLogBuffer({ maxLineBytes: 16 });
    buf.append("stdout", `${"x".repeat(100)}\n`);
    const [line] = buf.read().lines;
    expect(line?.text).toBe("x".repeat(16) + LOG_LINE_TRUNCATED);
  });

  test("cuts loose a writer that never emits a newline", () => {
    const buf = createLogBuffer({ maxLineBytes: 16 });
    buf.append("stdout", "y".repeat(40));
    expect(buf.read().lines).toHaveLength(1);
  });

  test("caps a page at the buffer's page limit however large the ask", () => {
    const buf = createLogBuffer({ maxLines: 10, maxPageLines: 3 });
    buf.append("stdout", "1\n2\n3\n4\n5\n");
    expect(buf.read(-1, 1000).lines).toHaveLength(3);
  });

  test("tail() reports the highest assigned seq, and -1 before anything lands", () => {
    const buf = createLogBuffer();
    expect(buf.tail()).toBe(-1);
    buf.append("stdout", "a\nb\n");
    expect(buf.tail()).toBe(1);
  });

  test("an empty append is a no-op", () => {
    const buf = createLogBuffer();
    buf.append("stdout", "");
    expect(buf.tail()).toBe(-1);
  });

  test("stamps each line with the clock", () => {
    const buf = createLogBuffer({ now: () => 1_700_000_000_000 });
    buf.append("stderr", "boom\n");
    expect(buf.read().lines[0]?.at).toBe(1_700_000_000_000);
  });

  test("the default page limit is the documented one", () => {
    const buf = createLogBuffer({ maxLines: DEFAULT_LOG_PAGE_LINES + 10 });
    buf.append(
      "stdout",
      `${Array.from({ length: DEFAULT_LOG_PAGE_LINES + 10 }, (_, i) => i).join("\n")}\n`,
    );
    expect(buf.read().lines).toHaveLength(DEFAULT_LOG_PAGE_LINES);
  });
});
