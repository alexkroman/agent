// Copyright 2026 the AAI authors. MIT license.
// The run case list against the memory reference, and the fixtures every case
// list builds its runs from.

import { describe, expect, test } from "vitest";
import { createMemoryJournal } from "./backends/memory.ts";
import {
  type JournalArm,
  journalIds,
  journalRunConformance,
  keysFor,
  runOf,
  startRun,
  stepOf,
} from "./conformance-cases.ts";

const store = createMemoryJournal();

const arm: JournalArm = {
  label: "memory (run list)",
  journal: () => store,
  uid: journalIds("mem-runs"),
  resumable: true,
};

journalRunConformance(arm);

describe("the case-list fixtures", () => {
  test("journalIds mints distinct ids under its label", () => {
    const uid = journalIds("lbl");
    const [a, b] = [uid(), uid()];
    expect(a).not.toBe(b);
    expect(a.startsWith(`lbl-${process.pid}-`)).toBe(true);
  });

  test("keysFor derives one run id, workflow and token from ONE uid", () => {
    const keys = keysFor({ ...arm, uid: () => "x1" });
    expect(keys).toEqual({ runId: "wrun-x1", workflow: "wf-x1", token: "tok-x1" });
  });

  test("runOf and stepOf fill the defaults a case does not care about", () => {
    expect(runOf({ runId: "wrun_1" })).toMatchObject({
      runId: "wrun_1",
      status: "pending",
      workflow: "conformance",
    });
    expect(stepOf({ key: "fetch#0" })).toMatchObject({ name: "fetch", status: "ok", attempts: 1 });
  });

  test("startRun creates the run in the arm's store and answers its keys", async () => {
    const started = await startRun(arm, { status: "running" });
    await expect(started.journal.getRun(started.runId)).resolves.toMatchObject({
      status: "running",
    });
  });
});
