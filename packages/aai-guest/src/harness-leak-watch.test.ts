// Copyright 2026 the AAI authors. MIT license.
// The watcher's whole value is the SECOND line — Node emits its own warning
// once and then goes quiet however far the count climbs — so most of what is
// pinned here is when a further report is and is not produced.

import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { installLeakWatch } from "./harness-leak-watch.ts";

/**
 * This suite's SUBJECT is `MaxListenersExceededWarning`: it synthesizes them
 * through `process.emit` and attaches 88 real listeners to a real emitter, so it
 * trips the repo-wide gate in `scripts/fail-on-process-warning.mjs` nine times
 * by construction. Opting out here rather than narrowing that gate keeps the
 * gate absolute everywhere else — this is the one suite in the repo for which
 * such a warning is the expected output rather than a defect, and
 * `aai-templates/vitest-setup-wiring.test.ts` asserts it stays the only one.
 *
 * Typed as a slot in the shape `sdk/step-env.ts` uses, because indexing bare
 * `globalThis` with a symbol is `TS7053`.
 */
const EXPECTS_PROCESS_WARNINGS = Symbol.for("aai.expectsProcessWarnings");
type WarningGateSlot = { [EXPECTS_PROCESS_WARNINGS]?: boolean };
(globalThis as WarningGateSlot)[EXPECTS_PROCESS_WARNINGS] = true;

const SWEEP_MS = 60_000;

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/** Install the watcher over a recording log, with virtual time for the sweep. */
function install(): string[] {
  const lines: string[] = [];
  vi.useFakeTimers();
  stop = installLeakWatch((message) => lines.push(message));
  return lines;
}

/** The warning Node mints, with the fields it really attaches. */
function warn(emitter: unknown, type: string, count: number): Error {
  return Object.assign(new Error(`${count} ${type} listeners added`), {
    name: "MaxListenersExceededWarning",
    emitter,
    type,
    count,
  });
}

test("reports a listener-leak warning naming the event and the count", () => {
  const lines = install();

  process.emit("warning", warn(new EventEmitter(), "chunk:strm_X_user", 11));

  expect(lines).toEqual(['Guest: listener leak suspected on "chunk:strm_X_user" — 11 listeners']);
});

test("ignores warnings that are not about listeners", () => {
  const lines = install();

  process.emit("warning", Object.assign(new Error("punycode"), { name: "DeprecationWarning" }));

  // Node prints those itself and they are not this module's business; a handler
  // that echoed every warning would double the guest's boot noise.
  expect(lines).toEqual([]);
});

test("reports AGAIN once the count has doubled — what Node itself never does", () => {
  const lines = install();
  const emitter = new EventEmitter();
  for (let i = 0; i < 11; i += 1) emitter.on("leaky", () => undefined);

  process.emit("warning", warn(emitter, "leaky", 11));
  for (let i = 0; i < 11; i += 1) emitter.on("leaky", () => undefined);
  vi.advanceTimersByTime(SWEEP_MS);

  expect(lines.at(-1)).toBe('Guest: listener leak GROWING on "leaky" — 22 listeners (was 11)');
});

test("says nothing while the count is merely stable or creeping", () => {
  const lines = install();
  const emitter = new EventEmitter();
  for (let i = 0; i < 11; i += 1) emitter.on("steady", () => undefined);

  process.emit("warning", warn(emitter, "steady", 11));
  emitter.on("steady", () => undefined);
  vi.advanceTimersByTime(SWEEP_MS * 5);

  // A high-water mark brushed once by a busy call must not become a per-minute
  // line in the log — that is how a real report gets ignored.
  expect(lines).toHaveLength(1);
});

test("each report raises the bar, so a growing leak yields a handful of lines", () => {
  const lines = install();
  const emitter = new EventEmitter();
  const add = (n: number): void => {
    for (let i = 0; i < n; i += 1) emitter.on("climbing", () => undefined);
  };
  add(11);
  process.emit("warning", warn(emitter, "climbing", 11));

  // 11 → 22 → 44 → 88 reports three times; a linear "+10" rule would report
  // seven times over the same climb.
  for (const target of [22, 44, 88]) {
    add(target - emitter.listenerCount("climbing"));
    vi.advanceTimersByTime(SWEEP_MS);
  }

  expect(lines).toHaveLength(4);
  expect(lines.at(-1)).toContain("88 listeners (was 44)");
});

test("an EventTarget is reported once and not tracked — it cannot be counted", () => {
  const lines = install();
  const controller = new AbortController();

  // Node attaches no `emitter` for an EventTarget warning, and a signal has no
  // `listenerCount`, so there is nothing to re-read. The first line is still
  // strictly more than the nothing an EventTarget gets by default.
  process.emit("warning", warn(controller.signal, "abort", 11));
  vi.advanceTimersByTime(SWEEP_MS * 3);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('on "abort" — 11 listeners');
});

test("stop() detaches the process listener, so a test cannot leak into the next", () => {
  const lines = install();

  stop?.();
  stop = undefined;
  process.emit("warning", warn(new EventEmitter(), "after-stop", 11));

  expect(lines).toEqual([]);
});

test("the sweep timer is unref'd, so it cannot hold an idling guest open", () => {
  vi.useFakeTimers();
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

  stop = installLeakWatch(() => undefined);

  // An agent guest self-exits on idle; a diagnostic that keeps the process
  // alive changes what it is measuring. `hasRef()` is the fake timer's own
  // bookkeeping, so this fails if the `unref()` call is dropped rather than
  // merely asserting that a timer exists.
  const timer: { hasRef?: () => boolean } | undefined = setIntervalSpy.mock.results[0]?.value;
  expect(timer?.hasRef?.()).toBe(false);
});
