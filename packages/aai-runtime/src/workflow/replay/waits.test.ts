// Copyright 2026 the AAI authors. MIT license.
// `ctx.sleep` and `ctx.waitFor` as one walk builds them: the keys they journal,
// when they return at once, when they PARK, and the refusals they raise.

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createMemoryJournal } from "../journal/backends/memory.ts";
import type { JournalStore, SleepRecord } from "../journal/types.ts";
import { createSuspendController, type SuspendController } from "./suspend.ts";
import { createWaitMethods } from "./waits.ts";

async function journalWithRun(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: "wrun_1",
    workflow: "intake",
    status: "running",
    createdAt: 0,
    input: null,
  });
  return journal;
}

function walk(journal: JournalStore, sleeps: ReadonlyMap<string, SleepRecord> = new Map()) {
  const suspend: SuspendController = createSuspendController();
  const refuse = vi.fn();
  const methods = createWaitMethods({
    runId: "wrun_1",
    workflow: "intake",
    journal,
    sleeps,
    suspend,
    refuse,
  });
  return { ...methods, suspend, refuse };
}

describe("sleep", () => {
  test("a deadline already past returns at once, having journaled its occurrence key", async () => {
    const journal = await journalWithRun();
    const w = walk(journal);
    await w.sleep("cool-off", new Date(0));
    await w.sleep("cool-off", new Date(0));
    const keys = (await journal.readSleeps("wrun_1")).map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["sleep!cool-off#0", "sleep!cool-off#1"]));
  });

  test("a future deadline PARKS the walk, and the suspension carries the wake time", async () => {
    const journal = await journalWithRun();
    const w = walk(journal);
    const before = Date.now();
    const settled = vi.fn();
    void w.sleep("later", 60_000).then(settled, settled);
    const suspension = await w.suspend.interruption.catch((err: unknown) =>
      w.suspend.suspensionOf(err),
    );
    expect(suspension?.wakeAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(settled).not.toHaveBeenCalled();
  });

  test("a sleep the snapshot already shows woken never touches the journal", async () => {
    const journal = await journalWithRun();
    const claimSleep = vi.spyOn(journal, "claimSleep");
    const snapshot = new Map<string, SleepRecord>([
      ["sleep!nap#0", { wakeAt: Number.MAX_SAFE_INTEGER, woken: true, kind: "sleep" }],
    ]);
    await walk(journal, snapshot).sleep("nap", 60_000);
    expect(claimSleep).not.toHaveBeenCalled();
  });
});

/** Run one walk's `waitFor` until it parks, answering what the suspension carried. */
async function parkOn(journal: JournalStore, token: string): Promise<unknown> {
  const first = walk(journal);
  void first.waitFor(token);
  return await first.suspend.interruption.catch((err: unknown) => err);
}

describe("waitFor", () => {
  test("an unanswered wait parks with no deadline; a later walk reads the delivered payload", async () => {
    const journal = await journalWithRun();
    await expect(parkOn(journal, "approval")).resolves.toEqual({ wakeAt: undefined });

    await journal.deliverHook("approval", { ok: true });
    await expect(walk(journal).waitFor("approval")).resolves.toEqual({ ok: true });
  });

  test("a timeout already elapsed closes the wait and answers undefined", async () => {
    const journal = await journalWithRun();
    await expect(walk(journal).waitFor("approval", { timeoutMs: 0 })).resolves.toBeUndefined();
  });

  test("a delivered payload that fails the schema is refused, naming the token", async () => {
    const journal = await journalWithRun();
    await parkOn(journal, "approval");
    await journal.deliverHook("approval", { ok: "yes" });
    const w = walk(journal);
    await expect(
      w.waitFor("approval", { schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toThrow();
    expect(w.refuse).toHaveBeenCalledWith(expect.stringContaining("approval"));
  });
});
