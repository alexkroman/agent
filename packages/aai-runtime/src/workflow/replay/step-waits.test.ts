// Copyright 2026 the AAI authors. MIT license.
/**
 * `StepOptions.maxWaits`: a far side's own `Retry-After` is waited out of its
 * own budget, and spends an attempt only once that budget is gone — or when
 * the body never opted in.
 */

import { publishStepReporter } from "@alexkroman1/aai/host-internal";
import { RetryableError } from "@alexkroman1/aai/step-errors";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { replayOn, seedRun } from "../_replay-test-utils.ts";

/** A `RetryableError` the far side dated a few milliseconds ahead. */
const comeBackLater = () => new RetryableError("rate limited", { retryAfter: 30 });

function reportedLines(): () => string[] {
  const lines: string[] = [];
  publishStepReporter(async (chunk) => {
    lines.push(String(chunk));
  });
  onTestFinished(() => publishStepReporter(undefined));
  return () => lines;
}

describe("StepOptions.maxWaits", () => {
  test("unset, a dated Retry-After spends an attempt as it always did", async () => {
    reportedLines();
    const journal = await seedRun();
    const call = vi.fn<() => string>().mockImplementation(() => {
      throw comeBackLater();
    });
    const outcome = await replayOn(journal, async (_input, ctx) =>
      ctx.step("call", call, { maxAttempts: 2 }),
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "failed" });
  });

  test("set, the waits come out of their own budget and the attempt count stays", async () => {
    const lines = reportedLines();
    const journal = await seedRun();
    const call = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw comeBackLater();
      })
      .mockImplementationOnce(() => {
        throw comeBackLater();
      })
      .mockReturnValue("ok");
    const outcome = await replayOn(journal, async (_input, ctx) =>
      ctx.step("call", call, { maxAttempts: 1, maxWaits: 2 }),
    );
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
    expect(call).toHaveBeenCalledTimes(3);
    // The entry records ONE attempt: the two waits were not tries.
    expect((await journal.readSteps("wrun_1"))[0]).toMatchObject({ attempts: 1 });
    expect(lines()).toEqual([
      expect.stringMatching(
        /^Step call was asked to retry in \d+ms \(wait 1 of 2, attempt 1 of 1 not spent\)/,
      ),
      expect.stringMatching(
        /^Step call was asked to retry in \d+ms \(wait 2 of 2, attempt 1 of 1 not spent\)/,
      ),
    ]);
  });

  test("a RetryableError that NAMED no delay spends an attempt — the default fill is not a wait", async () => {
    reportedLines();
    const journal = await seedRun();
    // `orFail` mints exactly this for a 503 with no `Retry-After`, and the
    // class fills a one-second default that is "in the future" on every catch.
    const call = vi.fn<() => string>().mockImplementation(() => {
      throw new RetryableError("flaky");
    });
    const outcome = await replayOn(journal, async (_input, ctx) =>
      ctx.step("call", call, { maxAttempts: 1, maxWaits: 5 }),
    );
    // One try, spent: were the unnamed delay a wait, the body would have run
    // again out of the five.
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: "failed", error: { message: "flaky" } });
    expect((await journal.readSteps("wrun_1"))[0]).toMatchObject({ attempts: 1 });
  });

  test.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses maxWaits %s at the step's declaration, before any attempt",
    async (maxWaits) => {
      const journal = await seedRun();
      const call = vi.fn<() => string>().mockReturnValue("ok");
      const outcome = await replayOn(journal, async (_input, ctx) =>
        ctx.step("call", call, { maxAttempts: 1, maxWaits }),
      );
      expect(call).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: "failed",
        error: { message: expect.stringContaining('ctx.step("call"): maxWaits must be') },
      });
      expect(await journal.readSteps("wrun_1")).toEqual([]);
    },
  );

  test("once the waits are spent, the next delay is a failure like any other", async () => {
    reportedLines();
    const journal = await seedRun();
    const call = vi.fn<() => string>().mockImplementation(() => {
      throw comeBackLater();
    });
    const outcome = await replayOn(journal, async (_input, ctx) =>
      ctx.step("call", call, { maxAttempts: 1, maxWaits: 1 }),
    );
    // One wait, then the single attempt: two runs of the body.
    expect(call).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "failed", error: { message: "rate limited" } });
  });

  test("a retryable failure with NO future delay still spends an attempt", async () => {
    reportedLines();
    const journal = await seedRun();
    const call = vi.fn<() => string>().mockImplementation(() => {
      throw new RetryableError("flaky", { retryAfter: 0 });
    });
    const outcome = await replayOn(journal, async (_input, ctx) =>
      ctx.step("call", call, { maxAttempts: 2, maxWaits: 5 }),
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "failed" });
  });
});
