// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload gate.
 *
 * Small enough to read in one screen and worth specced anyway, because three of
 * its rules are the kind that look like details and are not: a resumed gate has
 * to hand out a FRESH signal, a cancelled one has to RELEASE rather than hold,
 * and a pause immediately followed by a resume must not leave an uploader parked
 * forever. Each of those turns into an upload that never finishes.
 */

import { describe, expect, test, vi } from "vitest";
import { createUploadGate, isAbortError, randomUploadId } from "./_upload-session.ts";

describe("randomUploadId", () => {
  test("is random, because an upload id is a capability", () => {
    // Anyone holding it can read the bytes back, so it may not be derived from
    // the file, the form, or the time.
    const ids = new Set(Array.from({ length: 50 }, () => randomUploadId()));
    expect(ids.size).toBe(50);
  });

  test("carries nothing a path could interpret", () => {
    // The store treats a caller-chosen id as structural — a primary key, and a
    // key inside a bucket — so `UPLOAD_TOKEN_RE`'s allow-list is what it has to
    // satisfy by construction rather than by validation.
    expect(randomUploadId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("isAbortError", () => {
  test("reads the NAME, which is the only thing both shapes agree on", () => {
    // A `DOMException` in a browser and an `Error` subclass under Node's fetch.
    expect(isAbortError(Object.assign(new Error("stopped"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("createUploadGate", () => {
  test("starts open, with a signal that is not aborted", () => {
    const gate = createUploadGate();
    expect(gate.paused).toBe(false);
    expect(gate.cancelled).toBe(false);
    expect(gate.signal.aborted).toBe(false);
  });

  test("pausing aborts the bytes in flight and holds the uploader", async () => {
    const gate = createUploadGate();
    const signal = gate.signal;
    gate.pause();

    expect(gate.paused).toBe(true);
    expect(signal.aborted).toBe(true);
    const waiting = vi.fn();
    void gate.settle().then(waiting);
    await Promise.resolve();
    // Still parked: `settle` is what stops the loop sending the next window.
    expect(waiting).not.toHaveBeenCalled();
  });

  test("resuming installs a FRESH signal, since an aborted one stays aborted", async () => {
    const gate = createUploadGate();
    const paused = gate.signal;
    gate.pause();
    gate.resume();

    expect(gate.paused).toBe(false);
    expect(gate.signal).not.toBe(paused);
    // The whole point: the next attempt has to be abortable in its own right, and
    // a reused controller would fail it before it sent a byte.
    expect(gate.signal.aborted).toBe(false);
    await expect(gate.settle()).resolves.toBeUndefined();
  });

  test("a pause and an immediate resume leaves nobody parked", async () => {
    // The double-click, and the reason the uploader keys off the ABORT rather
    // than off `gate.paused`: this sequence resolves the gate before the
    // rejection the abort caused has even landed.
    const gate = createUploadGate();
    gate.pause();
    gate.resume();
    await expect(gate.settle()).resolves.toBeUndefined();
    expect(gate.paused).toBe(false);
  });

  test("cancelling RELEASES the gate rather than holding it", async () => {
    // Held, an uploader parked on `settle()` would wait for a resume that is not
    // coming — which is the abandoned submission never unwinding, and the run it
    // started never being cancelled.
    const gate = createUploadGate();
    gate.pause();
    gate.cancel();

    expect(gate.cancelled).toBe(true);
    expect(gate.paused).toBe(false);
    await expect(gate.settle()).resolves.toBeUndefined();
  });

  test("a cancelled gate never opens again", () => {
    const gate = createUploadGate();
    gate.cancel();
    gate.pause();
    gate.resume();

    expect(gate.cancelled).toBe(true);
    expect(gate.paused).toBe(false);
    // Still aborted: a resume after a cancel would hand the uploader a live
    // signal for a submission the page has already replaced.
    expect(gate.signal.aborted).toBe(true);
  });

  test("pausing twice is one pause, and resuming an open gate does nothing", async () => {
    const gate = createUploadGate();
    gate.pause();
    const first = gate.signal;
    gate.pause();
    expect(gate.signal).toBe(first);

    gate.resume();
    const open = gate.signal;
    gate.resume();
    // A second resume must not mint a signal the in-flight attempt is not using —
    // that attempt would then be unabortable and a later pause would do nothing.
    expect(gate.signal).toBe(open);
    await expect(gate.settle()).resolves.toBeUndefined();
  });
});
