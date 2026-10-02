// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext } from "./_test-utils.ts";
import { createRunCode, RUN_CODE_REFUSAL } from "./builtin-run-code.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";

/**
 * Invoke the host-side run_code def. run_code no longer executes on the host —
 * real execution happens inside the guest sandbox (see deno-harness). This
 * host-side def is a guard that refuses to evaluate code.
 */
function runCode(code: string): Promise<unknown> {
  const { defs } = resolveAllBuiltins(["run_code"]);
  return defs.run_code?.execute({ code }, createMockToolContext()) as Promise<unknown>;
}

describe("run_code with no executor (the host-side guard)", () => {
  test("run_code does not execute code on the host", async () => {
    const result = await runCode('console.log("hello")');
    expect(result).toEqual({
      error:
        "run_code is only available in the sandboxed runtime and cannot run in this environment.",
    });
  });

  test("run_code refuses even benign code on the host (no evaluation)", async () => {
    // A payload that WOULD have escaped the old node:vm sandbox must never be
    // evaluated on the host — the guard returns before any execution.
    const result = await runCode('console.log.constructor("return process")().env');
    expect(result).toHaveProperty("error");
    expect(result as { error: string }).not.toHaveProperty("env");
  });

  test("answers the exported refusal, which the eval harness reads", async () => {
    await expect(createRunCode().execute({ code: "1" }, createMockToolContext())).resolves.toEqual({
      error: RUN_CODE_REFUSAL,
    });
  });
});

describe("run_code with an executor", () => {
  test("hands the code to the executor and answers what it returned", async () => {
    const executor = vi.fn(async (code: string) => `ran ${code.length} chars`);
    const result = await createRunCode(executor).execute(
      { code: "console.log(1)" },
      createMockToolContext(),
    );
    expect(executor).toHaveBeenCalledWith("console.log(1)");
    expect(result).toBe("ran 14 chars");
  });

  test("passes an executor's in-band error through unchanged", async () => {
    const result = await createRunCode(async () => ({ error: "SyntaxError" })).execute(
      { code: "(" },
      createMockToolContext(),
    );
    expect(result).toEqual({ error: "SyntaxError" });
  });

  test("tells the model to compute rather than recite, in JavaScript", () => {
    const def = createRunCode();
    expect(def.guidance).toMatch(/JavaScript/);
    expect(def.inputSchema?.safeParse({ code: "1+1" }).success).toBe(true);
    expect(def.inputSchema?.safeParse({}).success).toBe(false);
  });
});
