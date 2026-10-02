// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STEP_MAX_ATTEMPTS,
  type PollOptions,
  type StepSchemaOptions,
} from "./workflow-ctx-options.ts";

describe("DEFAULT_STEP_MAX_ATTEMPTS", () => {
  test("gives a step two retries after its first attempt", () => {
    expect(DEFAULT_STEP_MAX_ATTEMPTS).toBe(3);
  });
});

describe("the option shapes", () => {
  test("a schema-validated step REQUIRES its schema", () => {
    const schema = z.object({ n: z.number() });
    expectTypeOf<{ schema: typeof schema }>().toExtend<StepSchemaOptions<typeof schema>>();
    expectTypeOf<{ maxAttempts: number }>().not.toExtend<StepSchemaOptions<typeof schema>>();
  });

  test("a poll names its cadence, its budget and its stop condition", () => {
    expectTypeOf<{
      everyMs: number;
      maxMs: number;
      done: (value: string) => boolean;
    }>().toExtend<PollOptions<string>>();
    expectTypeOf<{ everyMs: number; maxMs: number }>().not.toExtend<PollOptions<string>>();
  });
});
