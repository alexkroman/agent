// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { annotateDiagnostics } from "./studio-diagnostics.ts";

const TS7053 =
  "Type check failed:\nagent.ts(124,18): error TS7053: Element implicitly has an 'any' type " +
  "because expression of type 'string' can't be used to index type '{ entrance: ... }'.";

describe("annotateDiagnostics", () => {
  test("attaches the fixing idiom to the diagnostic that needs it", async () => {
    const out = await annotateDiagnostics(TS7053);
    expect(out).toContain(TS7053); // never replaces the original diagnostic
    expect(out).toContain("Record<string, Room>");
  });

  test("leaves output untouched when nothing is recognized", async () => {
    const plain = "Type check failed:\nagent.ts(1,1): error TS9999: something new.";
    expect(await annotateDiagnostics(plain)).toBe(plain);
  });

  test("passes through output with no diagnostics at all", async () => {
    expect(await annotateDiagnostics("Tests: passed.")).toBe("Tests: passed.");
  });

  test("hints once per code, not once per occurrence", async () => {
    // A file with the same mistake forty times must not produce forty
    // paragraphs — the point is to inform, not to flood the context.
    const many = Array.from(
      { length: 5 },
      (_, i) => `agent.ts(${i},1): error TS7006: Parameter 'x' implicitly has an 'any' type.`,
    ).join("\n");
    const hints =
      (await annotateDiagnostics(many)).split("Annotate the callback parameter").length - 1;
    expect(hints).toBe(1);
  });

  test("answers a wrong import by naming the module's real exports", async () => {
    // The agent guessed a name; the list is the fix, so give the list rather
    // than advice about how to look it up.
    const err = `agent.ts(2,10): error TS2305: Module '"@alexkroman1/aai"' has no exported member 'ToolCtx'.`;
    const out = await annotateDiagnostics(err, async (spec) =>
      spec === "@alexkroman1/aai" ? ["tool", "agent", "ToolContext"] : [],
    );
    expect(out).toContain('Exports of "@alexkroman1/aai"');
    expect(out).toContain("ToolContext");
  });

  test("omits the export list when the module cannot be resolved", async () => {
    const err = `agent.ts(2,10): error TS2305: Module '"mystery"' has no exported member 'X'.`;
    expect(await annotateDiagnostics(err, async () => [])).not.toContain("Exports of");
  });

  // Regression lock on the measured failure set: if a code loses its hint, the
  // repair loop it caused comes back. `test.each` rather than a loop so the
  // reporter names the code that regressed and the other six still run.
  test.each(["TS7053", "TS2538", "TS2339", "TS2345", "TS7006", "TS2304", "TS2880"])(
    "%s — a code the starter evals produced — carries a hint",
    async (code) => {
      const out = await annotateDiagnostics(`agent.ts(1,1): error ${code}: whatever.`);
      expect(out).toContain("Hints:");
    },
  );
});

describe("batched failures", () => {
  test("tells the agent to fix a repeated code in one pass", async () => {
    // Fifteen instances of one code is one mistake repeated, not fifteen
    // problems — repairing them one rebuild at a time is what burned a turn.
    const many = Array.from(
      { length: 15 },
      (_, i) => `agent.ts(${i},1): error TS7006: Parameter 'x' implicitly has an 'any' type.`,
    ).join("\n");
    const out = await annotateDiagnostics(many);
    expect(out).toContain("x15");
    expect(out).toMatch(/single pass/i);
  });

  test("stays quiet about batching for a one-off", async () => {
    const one = "agent.ts(1,1): error TS7006: Parameter 'x' implicitly has an 'any' type.";
    const out = await annotateDiagnostics(one);
    expect(out).toContain("x1");
    expect(out).not.toMatch(/single pass/i);
  });
});
