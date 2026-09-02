// Scratch reproduction — not to be committed.
import type { WorkflowCtx } from "@alexkroman1/aai";
import { expect, test } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { replayRun } from "./workflow-replay.ts";
import { sleep } from "@alexkroman1/aai/host-internal";

test("coin-flip body double-charges", async () => {
  let doubled = 0;
  const RUNS = 30;
  for (let i = 0; i < RUNS; i++) {
    const journal = createMemoryJournal();
    await journal.createRun({
      runId: `wrun_${i}`,
      workflow: "billing",
      status: "running",
      createdAt: Date.now(),
      input: {},
    });
    const charges: string[] = [];
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const coin = Math.random() < 0.5 ? "h" : "t";
      await ctx.step(`charge-${coin}`, () => {
        charges.push("CHARGED");
        return "receipt";
      });
      await ctx.sleep(5);
      return { charges: charges.length };
    };
    const opts = { runId: `wrun_${i}`, workflow: "billing", input: {}, run: body, journal };
    const first = await replayRun(opts);
    expect(first.kind).toBe("suspended");
    await sleep(10);
    const second = await replayRun(opts);
    if (charges.length > 1) doubled++;
    // every run reports completed with a clean log
    expect(second.kind).toBe("completed");
  }
  console.log(`DOUBLE-CHARGED ${doubled} of ${RUNS} runs; every run reported completed`);
  expect(doubled).toBe(0);
});
