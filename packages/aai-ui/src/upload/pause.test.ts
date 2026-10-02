// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useUploadPause` — the two buttons over a live upload.
 *
 * What is asserted is the FOLD: pausing parks the gate and sets `paused` on
 * the status the bar is already drawing, leaving which file and how far
 * untouched, and no status means nothing to fold into. What a paused gate does
 * to the bytes is `session.test.ts`'s subject.
 */

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import type { UploadStatus } from "../use-workflow-form.ts";
import { useUploadPause } from "./pause.ts";
import { createUploadGate, type UploadGate } from "./session.ts";

/** A bar mid-upload: the second of three files, half sent. */
const HALFWAY: UploadStatus = {
  name: "standup.wav",
  index: 2,
  count: 3,
  loaded: 50,
  total: 100,
  fraction: 0.5,
  paused: false,
};

/** The hook over a real status `useState`, as both submit hooks hold it. */
function renderPause(gate: UploadGate | undefined, initial: UploadStatus | undefined) {
  // One getter for the hook's life, the way the callers hold it in a ref.
  const getGate = () => gate;
  return renderHook(() => {
    const [upload, setUpload] = useState(initial);
    return { upload, ...useUploadPause(getGate, setUpload) };
  });
}

describe("useUploadPause", () => {
  test("pausing parks the gate and folds `paused` into the bar", () => {
    const gate = createUploadGate();
    const { result } = renderPause(gate, HALFWAY);

    act(() => result.current.pauseUpload());
    expect(gate.paused).toBe(true);
    // Folded, not replaced: everything else about the bar is still true.
    expect(result.current.upload).toEqual({ ...HALFWAY, paused: true });
  });

  test("resuming opens the gate and clears `paused`", () => {
    const gate = createUploadGate();
    const { result } = renderPause(gate, HALFWAY);

    act(() => result.current.pauseUpload());
    act(() => result.current.resumeUpload());
    expect(gate.paused).toBe(false);
    expect(result.current.upload).toEqual(HALFWAY);
  });

  test("with no bar on screen there is nothing to fold into", () => {
    const gate = createUploadGate();
    const { result } = renderPause(gate, undefined);

    act(() => result.current.pauseUpload());
    expect(gate.paused).toBe(true);
    expect(result.current.upload).toBeUndefined();
  });

  test("with no live submission the buttons only say so on the bar", () => {
    const { result } = renderPause(undefined, HALFWAY);
    expect(() => act(() => result.current.pauseUpload())).not.toThrow();
    expect(result.current.upload?.paused).toBe(true);
  });

  test("the callbacks are stable across renders", () => {
    const gate = createUploadGate();
    const { result, rerender } = renderPause(gate, HALFWAY);
    const { pauseUpload, resumeUpload } = result.current;
    rerender();
    expect(result.current.pauseUpload).toBe(pauseUpload);
    expect(result.current.resumeUpload).toBe(resumeUpload);
  });
});
