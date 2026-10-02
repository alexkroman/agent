// Copyright 2026 the AAI authors. MIT license.
// The generated-program grammar: its labelling, the output it predicts, and
// that `runProgram` really produces that output through a real engine.

import { describe, expect, test } from "vitest";
import { runScenario } from "./_resume-harness.ts";
import { expectedOutput, fails, label, type Program, tokensOf } from "./_resume-program.ts";

const PROGRAM: Program = [
  { t: "step", name: "", value: 1 },
  { t: "flaky", name: "", value: 2 },
  { t: "loop", name: "", count: 3 },
  { t: "sleep", waitLabel: "" },
  { t: "hook", token: "", mode: "signal" },
  { t: "hook", token: "", mode: "timeout" },
  { t: "all", children: [{ t: "step", name: "", value: 4 }] },
  {
    t: "map",
    width: 2,
    children: [
      { t: "step", name: "", value: 5 },
      { t: "step", name: "", value: 6 },
    ],
  },
  { t: "nested", name: "", children: [{ t: "step", name: "", value: 7 }] },
];

describe("label", () => {
  test("names every node and leaf uniquely, in program order", () => {
    const labelled = label(PROGRAM);
    expect(labelled[0]).toMatchObject({ name: "s0" });
    expect(labelled[3]).toMatchObject({ waitLabel: "w3" });
    expect(labelled[4]).toMatchObject({ token: "tok4" });
    expect(labelled[6]).toMatchObject({ children: [{ name: "s6" }] });
    expect(labelled[7]).toMatchObject({ children: [{ name: "s7" }, { name: "s8" }] });
  });

  test("is a pure function of the program", () => {
    expect(label(PROGRAM)).toEqual(label(PROGRAM));
  });
});

describe("the predictions", () => {
  test("expectedOutput gives each node's value, a timed-out hook undefined", () => {
    expect(expectedOutput(label(PROGRAM))).toEqual([
      1,
      2,
      [0, 1, 2],
      null,
      { ok: "tok4" },
      undefined,
      [4],
      [5, 6],
      [7],
    ]);
  });

  test("fails is true exactly when a boom is present", () => {
    expect(fails(PROGRAM)).toBe(false);
    expect(fails([...PROGRAM, { t: "boom", name: "" }])).toBe(true);
  });

  test("tokensOf lists every hook with its mode", () => {
    expect(tokensOf(label(PROGRAM))).toEqual([
      { token: "tok4", mode: "signal" },
      { token: "tok5", mode: "timeout" },
    ]);
  });
});

test("runProgram, driven to the end, produces exactly the predicted output", async () => {
  const program = label(PROGRAM);
  const scenario = await runScenario(program);
  expect(scenario.status).toBe("completed");
  expect(scenario.output).toEqual(expectedOutput(program));
});
