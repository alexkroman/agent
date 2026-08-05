// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import {
  createPostWriteDiagnostics,
  formatPostWriteDiagnostics,
  type TypecheckResult,
} from "./studio-write-diagnostics.ts";

const clean = async (): Promise<TypecheckResult> => ({ ok: true, skipped: false });
const red = async (): Promise<TypecheckResult> => ({
  ok: false,
  output: "Type check failed:\nagent.ts(1,1): error TS2322: nope",
});

/** A run whose verdict the test settles by hand. */
const deferred = () => Promise.withResolvers<TypecheckResult>();

describe("createPostWriteDiagnostics", () => {
  test("clean workspace appends nothing", async () => {
    const diagnose = createPostWriteDiagnostics(clean);
    expect(await diagnose("agent.ts")).toBeUndefined();
  });

  test("skipped check (no tsconfig) appends nothing", async () => {
    const diagnose = createPostWriteDiagnostics(async () => ({ ok: true, skipped: true }));
    expect(await diagnose("agent.ts")).toBeUndefined();
  });

  test("red check returns a block naming the file and the errors", async () => {
    const diagnose = createPostWriteDiagnostics(red);
    const out = await diagnose("agent.ts");
    expect(out).toContain("Type errors after writing agent.ts");
    expect(out).toContain("WAS saved");
    expect(out).toContain("error TS2322");
  });

  test("non-source files are never checked", async () => {
    let calls = 0;
    const diagnose = createPostWriteDiagnostics(async () => {
      calls++;
      return { ok: true, skipped: false };
    });
    expect(await diagnose("data/menu.json")).toBeUndefined();
    expect(await diagnose("README.md")).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a thrown checker degrades to no diagnostics, never an error", async () => {
    const diagnose = createPostWriteDiagnostics(async () => {
      throw new Error("tsc exploded");
    });
    expect(await diagnose("agent.ts")).toBeUndefined();
  });

  test("a wedged checker times out to no diagnostics", async () => {
    // A promise that never settles — the checker has wedged.
    const never = new Promise<TypecheckResult>(() => undefined);
    const diagnose = createPostWriteDiagnostics(() => never, 20);
    expect(await diagnose("agent.ts")).toBeUndefined();
  });

  test("callers arriving mid-run share one follow-up run", async () => {
    const first = deferred();
    const runs: (typeof first)[] = [first];
    let calls = 0;
    const diagnose = createPostWriteDiagnostics(() => {
      calls++;
      if (calls > runs.length) runs.push(deferred());
      const run = runs[calls - 1];
      if (!run) throw new Error("unreachable");
      return run.promise;
    });

    // First caller starts run 1; three more arrive while it is in flight.
    const a = diagnose("a.ts");
    const b = diagnose("b.ts");
    const c = diagnose("c.ts");
    const d = diagnose("d.ts");
    // The runner starts the first check on a microtask, so wait for it.
    await vi.waitFor(() => expect(calls).toBe(1));

    // Run 1's verdict cannot vouch for b/c/d — settling it starts exactly
    // ONE follow-up, shared by all three.
    first.resolve({ ok: false, output: "stale: error TS1111" });
    expect(await a).toContain("TS1111");
    await vi.waitFor(() => expect(calls).toBe(2));
    runs[1]?.resolve({ ok: true, skipped: false });
    expect(await b).toBeUndefined();
    expect(await c).toBeUndefined();
    expect(await d).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("a caller after the burst settles starts a fresh run", async () => {
    let calls = 0;
    const diagnose = createPostWriteDiagnostics(async () => {
      calls++;
      return { ok: true, skipped: false };
    });
    await diagnose("a.ts");
    await diagnose("b.ts");
    expect(calls).toBe(2);
  });
});

describe("formatPostWriteDiagnostics", () => {
  test("caps the error body but always keeps the Hints section", () => {
    const errors = Array.from(
      { length: 60 },
      (_, i) => `agent.ts(${i + 1},1): error TS2345: nope`,
    ).join("\n");
    const output = `Type check failed:\n${errors}\n\nHints:\n- TS2345 (x60): annotate the declaration`;
    const block = formatPostWriteDiagnostics("agent.ts", output);
    expect(block).toContain("more lines");
    expect(block).toContain("Hints:");
    expect(block).toContain("annotate the declaration");
    expect(block.split("\n").filter((l) => l.includes("error TS")).length).toBeLessThanOrEqual(40);
  });

  test("short output passes through uncapped", () => {
    const block = formatPostWriteDiagnostics("a.ts", "Type check failed:\na.ts(1,1): error TS1: x");
    expect(block).not.toContain("more lines");
    expect(block).toContain("error TS1");
  });
});
