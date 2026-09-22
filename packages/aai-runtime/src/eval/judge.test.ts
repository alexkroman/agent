// Copyright 2026 the AAI authors. MIT license.
/**
 * The judge, against a SCRIPTED model.
 *
 * What is pinned is the half that is ours, not the model's: rulings matched to
 * criteria by number, the verdict computed from them rather than asked for,
 * and a criterion the model skipped reported as a FAIL.
 */

import { describe, expect, test } from "vitest";
import { judgeCall, runJudge } from "./judge.ts";
import type { EvalTurn } from "./session.ts";
import { installStubLlm } from "./stub-llm.ts";

function scriptedJudge(answer: unknown) {
  return installStubLlm(JSON.stringify(answer));
}

const criteria = ["The agent looked the order up.", "The agent never asked for a card number."];

describe("judgeCall", () => {
  test("computes the verdict from per-criterion rulings, in criterion order", async () => {
    const stub = scriptedJudge({
      criteria: [
        { index: 2, pass: false, reason: "it asked for the card on turn 2" },
        { index: 1, pass: true, reason: "look_up ran first" },
      ],
      summary: "Mostly fine.",
    });
    try {
      const verdict = await judgeCall("Agent: hi", {
        criteria,
        llm: stub.llm,
        providerEnv: stub.env,
      });
      expect(verdict.pass).toBe(false);
      expect(verdict.scripted).toBe(false);
      expect(verdict.criteria.map((c) => c.pass)).toEqual([true, false]);
      expect(verdict.criteria[0]?.criterion).toBe(criteria[0]);
      expect(verdict.summary).toBe("Mostly fine.");
      expect(verdict.explain()).toContain("never asked for a card number");
      expect(verdict.explain()).not.toContain("looked the order up");
    } finally {
      stub.release();
    }
  });

  test("a criterion the judge skipped FAILS, never passes silently", async () => {
    const stub = scriptedJudge({
      criteria: [{ index: 1, pass: true, reason: "ok" }],
      summary: "",
    });
    try {
      const verdict = await judgeCall("Agent: hi", {
        criteria,
        llm: stub.llm,
        providerEnv: stub.env,
      });
      expect(verdict.pass).toBe(false);
      expect(verdict.criteria[1]?.reason).toMatch(/no ruling/);
    } finally {
      stub.release();
    }
  });

  test("refuses an empty criteria list, which would pass vacuously", async () => {
    const stub = scriptedJudge({ criteria: [], summary: "" });
    try {
      await expect(
        judgeCall("Agent: hi", { criteria: [], llm: stub.llm, providerEnv: stub.env }),
      ).rejects.toThrow(/at least one criterion/);
    } finally {
      stub.release();
    }
  });

  test("takes a list of turns, and a scripted run says it was one", async () => {
    const stub = scriptedJudge({
      criteria: [{ index: 1, pass: true, reason: "ok" }],
      summary: "fine",
    });
    const turns: EvalTurn[] = [
      { text: "It shipped.", events: [], toolCalls: [], completed: true, errors: [] },
    ];
    try {
      const verdict = await runJudge(
        turns,
        { criteria: ["It answered."], llm: stub.llm, providerEnv: stub.env },
        true,
      );
      expect(verdict.pass).toBe(true);
      expect(verdict.scripted).toBe(true);
      expect(verdict.explain()).toBe("all criteria passed");
    } finally {
      stub.release();
    }
  });
});
