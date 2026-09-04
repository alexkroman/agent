// Copyright 2026 the AAI authors. MIT license.
/**
 * The grader's own tests, which is the whole reason it is a module.
 *
 * It lived in `starter.eval.test.ts`, excluded by this package's
 * `vitest.config.ts`, so the function deciding WHICH checks exist and what each
 * is labelled was exercised only by a run needing a live key and a live studio —
 * while every function it calls was unit-tested next door. The labels are the
 * keys `EvalReport.unstable` reports and `AAI_EVAL_ONLY` matches, so a rename is
 * a silent reset of the flip history.
 */
import { describe, expect, test } from "vitest";
import { createRecorder } from "./runner.ts";
import { gradeStarter, type StarterRun } from "./starter-grade.ts";
import type { StudioTurn } from "./studio-target.ts";

const GREEN_OUTPUT = 'Agent "Desk" (pipeline mode), tools: a, b, c, d, e.';

function turnOf(over: Partial<StudioTurn> = {}): StudioTurn {
  return {
    toolCalls: ["test_agent"],
    testAgentRuns: [{ buildFailed: false, testsFailed: false, excerpt: "" }],
    redChecks: [],
    redExcerpts: [],
    lastTestAgentOutput: GREEN_OUTPUT,
    text: "",
    errors: [],
    ...over,
  };
}

function grade(over: Partial<StarterRun> = {}): Map<string, boolean> {
  const rec = createRecorder();
  gradeStarter(rec, {
    label: "not a declared starter",
    kind: "voice",
    turn: turnOf(),
    files: { "agent.ts": "export default agent({})" },
    ...over,
  });
  return new Map(rec.checks.map((c) => [c.label, c.ok]));
}

describe("gradeStarter", () => {
  test("the taxonomy is five checks a starter with no expectation still gets", () => {
    // Never verified, verified-and-broken, out of steps, a red verification and
    // a stream error are five distinct problems wanting five distinct fixes —
    // which is why "RED" was replaced by a label set. A starter this file
    // declares no `Expectation` for is graded on all of them anyway.
    expect([...grade().keys()]).toEqual([
      "verified (ran test_agent)",
      "endedGreen",
      "no stream errors",
      "under the step cap (80)",
      "first-try clean (no red verification)",
      "pipeline mode",
      "client UI",
    ]);
  });

  test("a turn that never ran test_agent fails verification and endedGreen", () => {
    const checks = grade({ turn: turnOf({ testAgentRuns: [], toolCalls: [] }) });
    expect(checks.get("verified (ran test_agent)")).toBe(false);
    expect(checks.get("endedGreen")).toBe(false);
  });

  test("only the LAST test_agent run decides endedGreen — a repaired build is green", () => {
    const checks = grade({
      turn: turnOf({
        testAgentRuns: [
          { buildFailed: true, testsFailed: false, excerpt: "error TS2345" },
          { buildFailed: false, testsFailed: false, excerpt: "" },
        ],
      }),
    });
    expect(checks.get("endedGreen")).toBe(true);
    // …and the repair still costs the first-try check, which is the point of
    // counting red verifications separately from the final verdict.
    expect(
      grade({ turn: turnOf({ redChecks: ["write_file"] }) }).get(
        "first-try clean (no red verification)",
      ),
    ).toBe(false);
  });

  test("a stream error and a runaway step count each fail their own check", () => {
    expect(grade({ turn: turnOf({ errors: ["sandbox went away"] }) }).get("no stream errors")).toBe(
      false,
    );
    const runaway = turnOf({ toolCalls: Array.from({ length: 200 }, () => "write_file") });
    expect(grade({ turn: runaway }).get("under the step cap (80)")).toBe(false);
  });

  test("a workflow project is graded on SHAPE, and neither on mode nor on a client", () => {
    // It has no session, so pipeline mode and a live-state client are questions
    // about a thing that does not exist in a workflow project.
    const checks = grade({
      kind: "workflow",
      files: {
        "agent.ts": "export default workflowApp({ name: 'W' })",
        "workflows/main.ts": "export default async function run() {}",
        "client.tsx": "export default page(() => null)",
      },
    });
    expect(checks.has("workflow-app shape")).toBe(true);
    expect(checks.get("workflow-app shape")).toBe(true);
    expect(checks.has("pipeline mode")).toBe(false);
    expect(checks.has("client UI")).toBe(false);
  });

  test("a declared starter additionally answers for the prompt's capabilities", () => {
    const checks = grade({
      label: "A pizza-ordering agent with a real cart",
      // Two of the four capabilities that prompt enumerates, and — via the
      // loaded config, which is the other evidence source — two tools against
      // its `minTools: 4`.
      turn: turnOf({ lastTestAgentOutput: 'Agent "P" (pipeline mode), tools: add_pizza.' }),
      files: { "agent.ts": "tools: { add_pizza: x, place_order: y }" },
    });
    expect(checks.get("covers the prompt's capabilities")).toBe(false);
    expect(checks.get("declares the named builtins")).toBe(true);
    expect(checks.get("declares enough tools")).toBe(false);
  });

  test("a non-pipeline agent fails the mode check, and the note names the mode", () => {
    const rec = createRecorder();
    gradeStarter(rec, {
      label: "x",
      kind: "voice",
      turn: turnOf({ lastTestAgentOutput: 'Agent "S" (s2s mode), tools: a.' }),
      files: { "agent.ts": "" },
    });
    const mode = rec.checks.find((c) => c.label === "pipeline mode");
    expect(mode?.ok).toBe(false);
    expect(mode?.detail).toMatch(/mode=s2s/);
  });

  test("a workspace that never synced is graded, not skipped", () => {
    // `client.workspace` returns undefined when the guest's end-of-turn sync
    // does not land, and an ungraded case reads as a green one.
    const checks = grade({ files: undefined });
    expect(checks.get("pipeline mode")).toBe(true);
    expect(checks.get("client UI")).toBe(true);
  });
});
