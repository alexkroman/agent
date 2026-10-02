// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow form's statechart with no React and no network: the lookup, a
 * submission's lifetime, the supersede and reset rules, and the pause. Every
 * body is a hand-held promise, so each race the machine exists for is driven
 * one step at a time rather than hoped for.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { tick } from "./_react-test-utils.ts";
import {
  createWorkflowForm,
  type SubmissionReports,
  type WorkflowFormStore,
} from "./_workflow-form-state.ts";
import { createUploadGate, type UploadGate } from "./upload/index.ts";
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

/** A submission whose body the spec drives: its reports, and how it ends. */
type Held = {
  gate: UploadGate;
  settle: ReturnType<typeof vi.fn<() => void>>;
  reports: () => SubmissionReports;
  finish: () => void;
  fail: (err: unknown) => void;
};

let store: WorkflowFormStore;
afterEach(() => store.stop());

/** A machine whose lookup answers whatever `find` resolves to. */
function form(find: () => Promise<string | undefined> = async () => undefined): WorkflowFormStore {
  store = createWorkflowForm({ find });
  return store;
}

/** Send a SUBMIT whose body waits for the spec. */
function submit(): Held {
  const gate = createUploadGate();
  const settle = vi.fn<() => void>();
  const end = Promise.withResolvers<void>();
  let reports: SubmissionReports | undefined;
  store.send({
    type: "SUBMIT",
    gate,
    settle,
    work: (r) => {
      reports = r;
      return end.promise;
    },
  });
  return {
    gate,
    settle,
    reports: () => {
      if (!reports) throw new Error("the body has not started");
      return reports;
    },
    finish: () => end.resolve(),
    fail: (err) => end.reject(err),
  };
}

describe("workflow form statechart — the lookup", () => {
  test("starts idle, with nothing to report", () => {
    expect(form().getView()).toEqual({
      runId: undefined,
      startError: undefined,
      upload: undefined,
      startedHere: false,
      busy: false,
    });
  });

  test("RECOVER is busy until the answer, then follows the run it names", async () => {
    form(async () => "wrun_9");
    store.send({ type: "RECOVER" });
    expect(store.getView().busy).toBe(true);
    await tick();
    expect(store.getView()).toMatchObject({ runId: "wrun_9", busy: false, startedHere: false });
  });

  test("a key with no runs goes back to idle", async () => {
    form(async () => undefined);
    store.send({ type: "RECOVER" });
    await tick();
    expect(store.getView()).toMatchObject({ runId: undefined, busy: false });
  });

  test("a failed lookup is REPORTED", async () => {
    form(async () => {
      throw new Error("agent unavailable");
    });
    store.send({ type: "RECOVER" });
    await tick();
    expect(store.getView()).toMatchObject({ startError: "agent unavailable", busy: false });
  });

  test("an answer landing after a SUBMIT is dropped, not reconciled", async () => {
    // What `setRunId(current => current ?? found)` used to patch: the submit
    // left `recovering`, which stopped the lookup.
    const found = Promise.withResolvers<string | undefined>();
    form(() => found.promise);
    store.send({ type: "RECOVER" });
    const held = submit();
    held.reports().started("wrun_1");

    found.resolve("wrun_old");
    await tick();
    expect(store.getView().runId).toBe("wrun_1");
  });

  test("an answer landing after a RESET adopts nothing", async () => {
    const found = Promise.withResolvers<string | undefined>();
    form(() => found.promise);
    store.send({ type: "RECOVER" });
    store.send({ type: "RESET" });
    expect(store.getView().busy).toBe(false);

    found.resolve("wrun_9");
    await tick();
    expect(store.getView().runId).toBeUndefined();
  });

  test("RECOVER is not taken while a run is on the page", async () => {
    const find = vi.fn(async () => "wrun_9");
    form(find);
    store.send({ type: "RECOVER" });
    await tick();
    store.send({ type: "RECOVER" });
    expect(find).toHaveBeenCalledOnce();
    expect(store.getView().busy).toBe(false);
  });
});

describe("workflow form statechart — a submission", () => {
  test("SUBMIT clears the previous result FIRST and marks the run as this page's", async () => {
    form(async () => {
      throw new Error("old failure");
    });
    store.send({ type: "RECOVER" });
    await tick();

    submit();
    expect(store.getView()).toMatchObject({
      busy: true,
      startedHere: true,
      runId: undefined,
      startError: undefined,
    });
  });

  test("reports the bar while it runs, and drops it once the submission is over", async () => {
    form();
    const held = submit();
    held.reports().progress(BAR);
    expect(store.getView().upload).toEqual(BAR);

    held.reports().started("wrun_1");
    held.finish();
    await tick();
    expect(store.getView()).toMatchObject({ runId: "wrun_1", upload: undefined, busy: false });
    expect(held.settle).toHaveBeenCalledOnce();
  });

  test("a failure is the submission's error, and settles rather than rejects", async () => {
    form();
    const held = submit();
    held.reports().progress(BAR);
    held.fail(new Error("url: invalid"));
    await tick();
    expect(store.getView()).toMatchObject({
      startError: "url: invalid",
      upload: undefined,
      busy: false,
    });
    expect(held.settle).toHaveBeenCalledOnce();
  });

  test("a SUPERSEDED submission is stopped: its gate cancelled, its reports refused", async () => {
    form();
    const stale = submit();
    const live = submit();
    expect(stale.gate.cancelled).toBe(true);
    expect(stale.settle).toHaveBeenCalledOnce();
    live.reports().progress(BAR);

    // The walk unwinds AFTER the live one is drawing its bar. None of this may
    // reach the machine — it is what the token compare in `end()` used to stop.
    stale.reports().progress({ ...BAR, name: "old.wav" });
    stale.reports().started("wrun_stale");
    stale.fail(new Error("Upload cancelled."));
    await tick();
    expect(store.getView()).toMatchObject({
      busy: true,
      upload: BAR,
      runId: undefined,
      startError: undefined,
    });
  });

  test("RESET abandons the bytes and drops the result, without reporting an error", async () => {
    form();
    const held = submit();
    held.reports().progress(BAR);
    held.reports().started("wrun_1");

    store.send({ type: "RESET" });
    expect(held.gate.cancelled).toBe(true);
    expect(held.settle).toHaveBeenCalledOnce();
    held.fail(new Error("Upload cancelled."));
    await tick();
    expect(store.getView()).toEqual({
      runId: undefined,
      startError: undefined,
      upload: undefined,
      startedHere: false,
      busy: false,
    });
  });

  test("stopping the machine abandons the submission and still settles it", async () => {
    // The unmount: no exit action runs, so the body's own `finally` settles.
    form();
    const held = submit();
    store.stop();
    expect(held.gate.cancelled).toBe(true);
    held.fail(new Error("Upload cancelled."));
    await tick();
    expect(held.settle).toHaveBeenCalled();
  });
});

describe("workflow form statechart — the pause", () => {
  test("PAUSE parks the live gate and folds `paused` into the bar; RESUME undoes both", () => {
    form();
    const held = submit();
    held.reports().progress(BAR);

    store.send({ type: "PAUSE" });
    expect(held.gate.paused).toBe(true);
    // Folded, not replaced: which file and how far are still true.
    expect(store.getView().upload).toEqual({ ...BAR, paused: true });

    store.send({ type: "RESUME" });
    expect(held.gate.paused).toBe(false);
    expect(store.getView().upload).toEqual(BAR);
  });

  test("a pause before the first report still parks the gate", () => {
    form();
    const held = submit();
    store.send({ type: "PAUSE" });
    expect(held.gate.paused).toBe(true);
    expect(store.getView().upload).toBeUndefined();
  });

  test("with no submission there is nothing to pause", () => {
    form();
    store.send({ type: "PAUSE" });
    store.send({ type: "RESUME" });
    expect(store.getView().busy).toBe(false);
  });
});

test("the view keeps its identity while nothing it shows has moved", () => {
  form();
  const before = store.getView();
  store.send({ type: "RESUME" });
  expect(store.getView()).toBe(before);
});
