// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useSubmissionState` — the scaffold both submit hooks share.
 *
 * Driven directly, with real upload gates as the tokens, because the rule this
 * module exists for is the one a hook-level spec reaches only by racing two
 * submits: a SUPERSEDED submission's `end` must not clear the live one's
 * state. The hooks' own walks are specced in `use-workflow-form.test.ts` and
 * `use-workflow-stream.test.ts`.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { type SubmissionToken, useSubmissionState } from "./_submission-state.ts";
import { createUploadGate } from "./upload/index.ts";
import type { UploadStatus } from "./use-workflow-form.ts";

const BAR: UploadStatus = {
  name: "standup.wav",
  index: 1,
  count: 1,
  loaded: 10,
  total: 100,
  fraction: 0.1,
  paused: false,
};

function token(): SubmissionToken {
  return { gate: createUploadGate() };
}

function renderState() {
  return renderHook(() => useSubmissionState<SubmissionToken>());
}

describe("useSubmissionState", () => {
  test("starts idle, with nothing to report", () => {
    const { result } = renderState();
    expect(result.current).toMatchObject({
      runId: undefined,
      starting: false,
      startError: undefined,
      upload: undefined,
    });
  });

  test("begin opens a submission and clears the previous result FIRST", () => {
    const { result } = renderState();
    act(() => {
      result.current.actions.setRunId("wrun_old");
      result.current.actions.setStartError("old failure");
    });

    act(() => result.current.actions.begin(token()));
    // A finished result under a form that is submitting again is the one wrong
    // answer this can give, and it looks like a right one.
    expect(result.current.starting).toBe(true);
    expect(result.current.runId).toBeUndefined();
    expect(result.current.startError).toBeUndefined();
  });

  test("begin cancels the gate of the submission it supersedes", () => {
    const { result } = renderState();
    const first = token();
    act(() => result.current.actions.begin(first));
    act(() => result.current.actions.begin(token()));
    expect(first.gate.cancelled).toBe(true);
  });

  test("end closes the live submission and drops the bar", () => {
    const { result } = renderState();
    const live = token();
    act(() => {
      result.current.actions.begin(live);
      result.current.actions.setUpload(BAR);
    });

    act(() => result.current.actions.end(live));
    expect(result.current.starting).toBe(false);
    expect(result.current.upload).toBeUndefined();
  });

  test("a SUPERSEDED submission's end changes nothing", () => {
    // Its walk unwinds after the next one has already set `starting`; clearing
    // there would report the live submission as finished and drop its bar.
    const { result } = renderState();
    const stale = token();
    const live = token();
    act(() => result.current.actions.begin(stale));
    act(() => {
      result.current.actions.begin(live);
      result.current.actions.setUpload(BAR);
    });

    act(() => result.current.actions.end(stale));
    expect(result.current.starting).toBe(true);
    expect(result.current.upload).toEqual(BAR);
  });

  test("reset abandons the bytes and drops the result, without reporting an error", () => {
    const { result } = renderState();
    const live = token();
    act(() => {
      result.current.actions.begin(live);
      result.current.actions.setRunId("wrun_1");
      result.current.actions.setUpload(BAR);
    });

    act(() => result.current.actions.reset());
    expect(live.gate.cancelled).toBe(true);
    expect(result.current.runId).toBeUndefined();
    expect(result.current.upload).toBeUndefined();
    expect(result.current.startError).toBeUndefined();
  });

  test("pause and resume reach the LIVE submission's gate", () => {
    const { result } = renderState();
    const live = token();
    act(() => {
      result.current.actions.begin(live);
      result.current.actions.setUpload(BAR);
    });

    act(() => result.current.actions.pauseUpload());
    expect(live.gate.paused).toBe(true);
    expect(result.current.upload?.paused).toBe(true);

    act(() => result.current.actions.resumeUpload());
    expect(live.gate.paused).toBe(false);
    expect(result.current.upload?.paused).toBe(false);
  });

  test("the actions bag keeps its identity through state changes", () => {
    // It is a dependency of each hook's `submit`; a bag that moved on every
    // progress report would rebuild the form's `onSubmit` with it.
    const { result } = renderState();
    const actions = result.current.actions;
    act(() => {
      actions.begin(token());
      actions.setUpload(BAR);
      actions.setRunId("wrun_1");
    });
    expect(result.current.actions).toBe(actions);
  });
});
