// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { FatalError } from "./step-error-classes.ts";
import { StepGenerateError } from "./step-generate.ts";
import { stepGenerateJson } from "./step-generate-json.ts";
import { failable, orFail } from "./tool-failure-flow.ts";
import { type ToolFailure, toolFailure } from "./utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("orFail(call) — the function arm", () => {
  test("a carried verdict becomes the engine's: retryable: false is FATAL", async () => {
    const refuse = async (): Promise<string> => {
      throw new StepGenerateError("bad key", { retryable: false });
    };

    await expect(orFail(refuse)()).rejects.toSatisfy(FatalError.is);
  });

  test("an unclassifiable failure passes through UNCHANGED", async () => {
    const boom = new TypeError("not a verdict");
    const call = async (): Promise<number> => {
      throw boom;
    };

    await expect(orFail(call)()).rejects.toBe(boom);
  });

  test("arguments and the resolved value pass straight through", async () => {
    const add = vi.fn(async (a: number, b: number) => a + b);

    expect(await orFail(add)(2, 3)).toBe(5);
    expect(add).toHaveBeenCalledWith(2, 3);
  });

  test("a SYNC function stays sync, its throw classified", () => {
    const double = (n: number) => n * 2;
    const wrapped = orFail(double);
    expect(wrapped(4)).toBe(8);

    const refuse = (): number => {
      throw new StepGenerateError("bad key", { retryable: false });
    };
    expect(() => orFail(refuse)()).toThrow(
      expect.toSatisfy(
        (err: unknown) => FatalError.is(err) && (err as Error).message === "bad key",
      ),
    );
  });

  test("a generic call keeps its type parameters", () => {
    const Reply = z.object({ headline: z.string() });
    const ask = orFail(stepGenerateJson);
    // Never called — the claim is the inferred type, not a reply.
    const summarize = () => ask("Summarize.", { schema: Reply });
    expectTypeOf(summarize).returns.resolves.toEqualTypeOf<{ headline: string }>();
  });
});

describe("orFail(value) — the tool arm is unchanged", () => {
  test("forwards a ToolFailure out of the enclosing failable", () => {
    const failure = toolFailure("No such order.");
    const find = (id: string): { id: string } | ToolFailure => (id === "A1" ? { id } : failure);
    const lookup = failable((id: string) => orFail(find(id)).id);

    expect(lookup("A1")).toBe("A1");
    expect(lookup("B2")).toBe(failure);
  });
});
