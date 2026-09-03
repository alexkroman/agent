// Copyright 2026 the AAI authors. MIT license.
/**
 * The two properties the four hand-written copies got right and a fifth copy
 * would be free to get wrong: a throw comes back as `{ error }` for the MODEL to
 * read, and the timeout is not optional.
 */
import { describe, expect, test } from "vitest";
import { createVmRunCode } from "./vm-run-code.ts";

describe("createVmRunCode", () => {
  test("answers with what the code printed, joined by newlines", async () => {
    const run = createVmRunCode();
    expect(await run("console.log('a'); console.log('b')")).toBe("a\nb");
  });

  test("prints a non-string as JSON, because String({}) is unassertable", async () => {
    const run = createVmRunCode();
    expect(await run("console.log({ total: 3 }, 7, 'x')")).toBe('{"total":3} 7 x');
  });

  test("code that prints nothing answers the empty string, not undefined", async () => {
    expect(await createVmRunCode()("1 + 1")).toBe("");
  });

  test("a throw comes back as { error }, so the model can fix its own code", async () => {
    const answered = await createVmRunCode()("nope()");
    expect(answered).toEqual({ error: expect.stringContaining("nope") });
  });

  test("a syntax error is an answer too, never a rejection of the executor", async () => {
    const run = createVmRunCode();
    await expect(run("const = ;")).resolves.toEqual({
      error: expect.stringContaining("Unexpected"),
    });
  });

  test("an infinite loop is bounded by the timeout and reported as an error", async () => {
    // The property that stops a model's `while (true) {}` from hanging the case
    // to the suite deadline, which reads as a broken harness rather than as a
    // finding. 5ms so the spec is fast; the default is 1000.
    const answered = await createVmRunCode({ timeoutMs: 5 })("while (true) {}");
    expect(answered).toEqual({ error: expect.stringContaining("imed out") });
  });

  test("each call gets a FRESH context, so one case cannot seed the next", async () => {
    const run = createVmRunCode();
    await run("globalThis.leaked = 1");
    expect(await run("console.log(typeof globalThis.leaked)")).toBe("undefined");
  });

  test("extra globals are visible, and console stays available beside them", async () => {
    const run = createVmRunCode({ globals: { rate: 1.25 } });
    expect(await run("console.log(2 * rate)")).toBe("2.5");
  });

  test("nothing but console is granted by default", async () => {
    expect(await createVmRunCode()("console.log(typeof process)")).toBe("undefined");
  });
});
