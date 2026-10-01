// Copyright 2026 the AAI authors. MIT license.
/**
 * `start(…, { dedupeKey })`: the derived id, and the engine meeting two starts
 * at one run — sequentially, racing, and after the first run has finished.
 */

import { workflow } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_logger-test-utils.ts";
import { dedupedRunId } from "./dedupe-run-id.ts";
import { createWorkflowEngine } from "./engine.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";
import type { JournalStore } from "./journal/types.ts";
import { createMemoryStreams } from "./streams.ts";

describe("dedupedRunId", () => {
  test("is a minted id's shape, stable, and scoped to the workflow", () => {
    const id = dedupedRunId("memorize", "session-1:42");
    expect(id).toMatch(/^wrun_[0-9a-f]{32}$/);
    expect(dedupedRunId("memorize", "session-1:42")).toBe(id);
    expect(dedupedRunId("remind", "session-1:42")).not.toBe(id);
    expect(dedupedRunId("memorize", "session-1:43")).not.toBe(id);
  });

  test("keeps the workflow and the key apart", () => {
    expect(dedupedRunId("a", "b:c")).not.toBe(dedupedRunId("a:b", "c"));
  });
});

function engineOver(journal: JournalStore = createMemoryJournal()) {
  const dispatch = vi.fn();
  let n = 0;
  const engine = createWorkflowEngine({
    workflows: { memorize: workflow({ run: () => "done" }) },
    journal,
    streams: createMemoryStreams(),
    dispatch,
    newRunId: () => `wrun_${++n}`,
    logger: silentLogger,
  });
  return { engine, dispatch, journal };
}

describe("engine.start with a dedupeKey", () => {
  test("a second start answers the first run and creates and dispatches nothing", async () => {
    const { engine, dispatch, journal } = engineOver();
    const createRun = vi.spyOn(journal, "createRun");
    const first = await engine.start("memorize", [{ n: 1 }], { dedupeKey: "s1:7" });
    const second = await engine.start("memorize", [{ n: 2 }], { dedupeKey: "s1:7" });
    expect(second).toBe(first);
    expect(first).toBe(dedupedRunId("memorize", "s1:7"));
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The FIRST start's input is what runs.
    expect((await journal.getRun(first))?.input).toEqual({ n: 1 });
  });

  test("dedupes against a FINISHED run too", async () => {
    const { engine } = engineOver();
    const first = await engine.start("memorize", [{}], { dedupeKey: "evt_1" });
    expect(await engine.execute(first)).toBe("completed");
    expect(await engine.start("memorize", [{}], { dedupeKey: "evt_1" })).toBe(first);
  });

  test("two racing starts create one run, and the loser answers the winner's id", async () => {
    const { engine, dispatch, journal } = engineOver();
    const createRun = vi.spyOn(journal, "createRun");
    const [a, b] = await Promise.all([
      engine.start("memorize", [{}], { dedupeKey: "evt_2" }),
      engine.start("memorize", [{}], { dedupeKey: "evt_2" }),
    ]);
    expect(a).toBe(b);
    // Both passed the existence check before either inserted; one insert lost.
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("a createRun failure that left no run is still the start's failure", async () => {
    const journal = createMemoryJournal();
    vi.spyOn(journal, "createRun").mockRejectedValue(new Error("store down"));
    const { engine } = engineOver(journal);
    await expect(engine.start("memorize", [{}], { dedupeKey: "evt_3" })).rejects.toThrow(
      "store down",
    );
  });

  test("different keys, and no key, start separate runs", async () => {
    const { engine } = engineOver();
    const a = await engine.start("memorize", [{}], { dedupeKey: "x" });
    const b = await engine.start("memorize", [{}], { dedupeKey: "y" });
    const c = await engine.start("memorize", [{}]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
