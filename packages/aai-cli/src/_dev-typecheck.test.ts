// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev`'s background typecheck. The properties that matter are that it
 * never takes the server down and never floods a save with `tsc` processes —
 * the diagnostics themselves are `typecheck.ts`'s job and tested there.
 */
import { describe, expect, test, vi } from "vitest";
import { createDevTypecheck } from "./_dev-typecheck.ts";
import * as typecheck from "./typecheck.ts";

const reports: [string, string][] = [];
const report = (level: "warn" | "error", message: string) => {
  reports.push([level, message]);
};

describe("createDevTypecheck", () => {
  test("a failing project is REPORTED, not thrown — dev must keep serving", async () => {
    reports.length = 0;
    vi.spyOn(typecheck, "typecheckProject").mockResolvedValue({
      ok: false,
      output: "agent.ts(6,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    });
    const dev = createDevTypecheck("/nowhere", report);
    expect(() => {
      dev.request();
    }).not.toThrow();
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]?.[0]).toBe("warn");
    expect(reports[0]?.[1]).toContain("TS2322");
    // Says what it does NOT do, because a dev server that prints an error and
    // keeps working has to explain itself or it reads as a crash.
    expect(reports[0]?.[1]).toContain("keeps serving");
  });

  test("a clean project says nothing — a per-save checkmark trains you to stop reading", async () => {
    reports.length = 0;
    vi.spyOn(typecheck, "typecheckProject").mockResolvedValue({ ok: true, skipped: false });
    const dev = createDevTypecheck("/nowhere", report);
    dev.request();
    await vi.waitFor(() => expect(typecheck.typecheckProject).toHaveBeenCalled());
    expect(reports).toEqual([]);
  });

  test("a burst of saves coalesces — one run in flight, at most one queued behind it", async () => {
    reports.length = 0;
    let running = 0;
    let peak = 0;
    let calls = 0;
    vi.spyOn(typecheck, "typecheckProject").mockImplementation(async () => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;
      return { ok: true, skipped: false };
    });
    const dev = createDevTypecheck("/nowhere", report);
    for (let i = 0; i < 8; i++) dev.request();
    await vi.waitFor(() => expect(running).toBe(0));
    expect(peak).toBe(1);
    // Eight saves must not be eight `tsc` processes; the trailing run exists so
    // the last edit is still checked.
    expect(calls).toBeLessThanOrEqual(2);
  });

  test("a throw from the checker is reported, never surfaced to the server", async () => {
    reports.length = 0;
    vi.spyOn(typecheck, "typecheckProject").mockRejectedValue(new Error("spawn ENOENT"));
    const dev = createDevTypecheck("/nowhere", report);
    dev.request();
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]?.[0]).toBe("error");
    expect(reports[0]?.[1]).toContain("spawn ENOENT");
  });
});
