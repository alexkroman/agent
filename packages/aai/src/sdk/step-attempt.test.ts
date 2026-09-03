// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepInfo()` — the reader, its unpublished default, and the derivation the
 * fake must not let a spec contradict.
 *
 * The interesting claims are about ABSENCE and about `isLastAttempt`, which is
 * the field a body branches on: a wrong `undefined` sends a step down its
 * non-retrying path forever, and a wrong ceiling makes it degrade early on every
 * run while still returning an answer. Neither failure is loud.
 */

import { describe, expect, onTestFinished, test } from "vitest";
import { publishStepInfoReader, stepInfo } from "./step-attempt.ts";
import { stubStepInfo } from "./testing.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS } from "./workflow-ctx-options.ts";

describe("with nothing published", () => {
  test("answers undefined rather than throwing, which is what a spec needs", () => {
    // The DevKit's `getStepMetadata()` threw here, which is why its
    // `workflow-report.ts` wrapped every call in a try/catch. An exported step
    // is also an ordinary async function and every template's tests call one
    // directly, so absence has to be an answer.
    publishStepInfoReader(undefined);
    expect(stepInfo()).toBeUndefined();
  });
});

describe("with a reader published", () => {
  test("answers what the reader says, per call rather than once", () => {
    // A reader rather than a value, because the answer changes per step and per
    // attempt while the slot is filled once at `createServer`.
    let attempt = 1;
    publishStepInfoReader(() => ({
      name: "charge",
      key: "charge#0",
      attempt,
      maxAttempts: 3,
      isLastAttempt: attempt >= 3,
    }));
    onTestFinished(() => publishStepInfoReader(undefined));

    expect(stepInfo()?.attempt).toBe(1);
    expect(stepInfo()?.isLastAttempt).toBe(false);
    attempt = 3;
    expect(stepInfo()?.attempt).toBe(3);
    expect(stepInfo()?.isLastAttempt).toBe(true);
  });

  test("unpublishing restores the absent answer", () => {
    publishStepInfoReader(() => ({
      name: "s",
      key: "s#0",
      attempt: 1,
      maxAttempts: 1,
      isLastAttempt: true,
    }));
    publishStepInfoReader(undefined);
    expect(stepInfo()).toBeUndefined();
  });
});

describe("stubStepInfo", () => {
  test("defaults to a first attempt under the SDK's own ceiling", () => {
    onTestFinished(stubStepInfo({}).restore);
    expect(stepInfo()).toEqual({
      name: "step",
      key: "step#0",
      attempt: 1,
      maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
      isLastAttempt: false,
    });
  });

  test("derives isLastAttempt rather than accepting it", () => {
    // A fake that took the flag would let a body pass against a state no run can
    // be in — attempt 1 of 3 reporting itself as the last try.
    onTestFinished(stubStepInfo({ attempt: 3, maxAttempts: 3 }).restore);
    expect(stepInfo()?.isLastAttempt).toBe(true);
  });

  test("raises the ceiling to fit an attempt past the default", () => {
    // Otherwise `stubStepInfo({ attempt: 5 })` describes attempt 5 of 3, and a
    // spec meaning "deep into the retries" would silently get `isLastAttempt`
    // from a contradiction.
    onTestFinished(stubStepInfo({ attempt: 5 }).restore);
    expect(stepInfo()).toMatchObject({ attempt: 5, maxAttempts: 5, isLastAttempt: true });
  });

  test("names the step, so a body that reads the name sees the one under test", () => {
    onTestFinished(stubStepInfo({ name: "transcribe" }).restore);
    expect(stepInfo()).toMatchObject({ name: "transcribe", key: "transcribe#0" });
  });
});
