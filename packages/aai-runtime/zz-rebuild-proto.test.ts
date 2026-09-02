// Copyright 2026 the AAI authors. MIT license.
/** Scratch prototype — delete. */
import { type WorkflowCtx, workflow } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createInProcessWorkflowEngine } from "./workflow-in-process.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";

describe("proto", () => {
  test("rebuild wakes a parked sleep", async () => {
    vi.useFakeTimers();
    try {
      const journal = createMemoryJournal();
      const logger = makeLogger();
      const ran: string[] = [];
      const workflows = {
        generated: workflow({
          description: "g",
          run: async (_i: Record<string, unknown>, ctx: WorkflowCtx) => {
            await ctx.step("a", async () => {
              ran.push("a");
              return 1;
            });
            await ctx.sleep(60_000);
            await ctx.step("b", async () => {
              ran.push("b");
              return 2;
            });
            return "done";
          },
        }),
      };
      const make = () => createInProcessWorkflowEngine({ workflows, journal, logger });
      let engine = make();
      const runId = await engine.start("generated", [{}]);
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
      console.log("after start", await journal.getRun(runId), ran);

      engine.stop();
      engine = make();
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
      console.log("after rebuild settle", await journal.getRun(runId));
      await vi.advanceTimersByTimeAsync(60_000 + 100);
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
      console.log("after advance", await journal.getRun(runId), ran);
      expect(ran).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
