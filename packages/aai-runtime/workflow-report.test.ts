// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the published reporter — the half that turns one `report()` into a
 * stream chunk AND a server-log line.
 *
 * The run is entered through `withRunContext`, the engine's own
 * `AsyncLocalStorage`, which is REAL rather than mocked: it is this package's
 * and a spec can hold one. That replaced a `vi.mock("workflow")` supplying the
 * DevKit's `getWritable`/`getStepMetadata`, mocked because a real one needed a
 * world — so the conversion made the harness less fake, not more.
 *
 * What is asserted is unchanged: the ORDER (the log first, since a stream write
 * can fail and an operator still wants the line), the attempt suffix, and that
 * a failing stream never propagates.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createStepInfoReader, createStepReporter } from "./workflow-report.ts";
import { type RunContext, withRunContext, withStepContext } from "./workflow-run-context.ts";
import { DEFAULT_STREAM_NAMESPACE, streamNamespace } from "./workflow-streams.ts";

/** The step this run is inside, which the reporter reads for the suffix. */
let step: RunContext["step"];
/**
 * Every chunk written, keyed by the RESOLVED namespace.
 *
 * Through `streamNamespace`, not `?? ""`: production resolves an absent
 * namespace to `DEFAULT_STREAM_NAMESPACE` (`workflow-replay.ts` hands the raw
 * value to the store, which resolves it), and a fake that keyed the default
 * channel under `""` would be the laxer-than-the-interface double
 * `workflow-streams.ts`'s own doc warns about — this spec could not then see a
 * namespace-resolution regression.
 */
let streams: Map<string, unknown[]>;
/** What the run's `write` does. Overridden by the failure case. */
let onWrite: ((namespace: string | undefined, value: unknown) => Promise<number>) | undefined;

/** Run `fn` inside a run context, the way a replaying body would. */
function inRun<T>(fn: () => Promise<T> | T): Promise<T> {
  return withRunContext(
    {
      runId: "wrun_1",
      workflow: "transcribe",
      step,
      write: async (namespace, value) => {
        if (onWrite) return onWrite(namespace, value);
        const key = streamNamespace(namespace);
        const written = streams.get(key) ?? [];
        streams.set(key, written);
        written.push(value);
        return written.length;
      },
    },
    async () => fn(),
  );
}

/** The default stream's chunks — `report()`'s own. */
const defaultStream = () => streams.get(DEFAULT_STREAM_NAMESPACE) ?? [];

beforeEach(() => {
  step = { name: "transcribeSegment", key: "step_1", attempt: 1, maxAttempts: 3 };
  streams = new Map();
  onWrite = undefined;
});

describe("createStepReporter", () => {
  test("writes the line to the run's stream and to the log", async () => {
    const log = makeLogger();
    await inRun(() => createStepReporter(log)("Transcribing 0:00–0:58."));
    expect(defaultStream()).toEqual(["Transcribing 0:00–0:58."]);
    expect(log.info).toHaveBeenCalledWith(
      "Workflow: Transcribing 0:00–0:58.",
      expect.objectContaining({ step: "transcribeSegment", attempt: 1 }),
    );
  });

  test("NAMES the attempt past the first, in the line a page renders", async () => {
    // A fan-out that is retrying looks identical to one that is succeeding —
    // the same sentence, sixty times — unless the attempt is in the line.
    step = { name: "transcribeSegment", key: "s", attempt: 3, maxAttempts: 3 };
    await inRun(() => createStepReporter(makeLogger())("Transcribing 0:00–0:58."));
    expect(defaultStream()).toEqual(["Transcribing 0:00–0:58. (attempt 3)"]);
  });

  test("says nothing extra on the first attempt", async () => {
    await inRun(() => createStepReporter(makeLogger())("Filing the findings."));
    expect(defaultStream()).toEqual(["Filing the findings."]);
  });

  test("still logs when there is no step around it", async () => {
    // A workflow BODY is not a step, and it is a legitimate place to report
    // from — so is a tool. The run is still there; only the step is absent.
    step = undefined;
    const log = makeLogger();
    await inRun(() => createStepReporter(log)("Planning."));
    expect(defaultStream()).toEqual(["Planning."]);
    expect(log.info).toHaveBeenCalledWith("Workflow: Planning.", {});
  });

  test("keeps the log line when the stream write fails", async () => {
    // The reader that cannot go away is the operator; a page that closed
    // mid-run is the ordinary case, which is why this is a debug and not a warn.
    onWrite = () => Promise.reject(new Error("stream is gone"));
    const log = makeLogger();
    await expect(inRun(() => createStepReporter(log)("Still going."))).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("Workflow: Still going.", expect.anything());
    expect(log.debug).toHaveBeenCalledWith(
      "Workflow progress not streamed",
      expect.objectContaining({ error: expect.stringContaining("stream is gone") }),
    );
  });
});

describe("a chunk emitted into a named stream", () => {
  test("goes to THAT stream and not to the default one", async () => {
    const log = makeLogger();
    await inRun(() =>
      createStepReporter(log)(
        { index: 3, text: "and then we shipped it" },
        { namespace: "transcript", log: false },
      ),
    );
    expect(streams.get("transcript")).toEqual([{ index: 3, text: "and then we shipped it" }]);
    // The default stream is `report()`'s, and an object in it renders as
    // `[object Object]` in the middle of a page's progress log.
    expect(streams.get(DEFAULT_STREAM_NAMESPACE)).toBeUndefined();
  });

  test("is not logged, so a chunk per segment cannot bury the narration", async () => {
    const log = makeLogger();
    await inRun(() =>
      createStepReporter(log)({ index: 3 }, { namespace: "transcript", log: false }),
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  test("takes NO attempt suffix — a chunk is parsed, not read", async () => {
    // The suffix is what tells a human reader a fan-out is retrying. Appended to
    // a value it is either lost or corruption, and the narration beside it is
    // where a retry is already visible.
    step = { name: "transcribeSegment", key: "s", attempt: 3, maxAttempts: 3 };
    await inRun(() =>
      createStepReporter(makeLogger())({ text: "hello" }, { namespace: "transcript", log: false }),
    );
    expect(streams.get("transcript")).toEqual([{ text: "hello" }]);
  });

  test("names the stream when a write is lost", async () => {
    onWrite = () => Promise.reject(new Error("stream is gone"));
    const log = makeLogger();
    await expect(
      inRun(() => createStepReporter(log)({ index: 1 }, { namespace: "transcript", log: false })),
    ).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalledWith(
      "Workflow progress not streamed",
      expect.objectContaining({ namespace: "transcript" }),
    );
  });

  test("a LINE still goes to the default stream, with its attempt suffix", async () => {
    // The other half of the same reporter: `report()` passes no namespace, and
    // an absent one IS the default stream — `streamNamespace` owns that
    // resolution, which is why `write` takes it unresolved.
    step = { name: "transcribeSegment", key: "s", attempt: 2, maxAttempts: 3 };
    const log = makeLogger();
    await inRun(() => createStepReporter(log)("Transcribing 0:00–0:58.", { log: true }));
    expect(defaultStream()).toEqual(["Transcribing 0:00–0:58. (attempt 2)"]);
    expect(log.info).toHaveBeenCalled();
  });
});

/**
 * The step-info reader, which is `createStepReporter`'s sibling: both are the
 * published half of a `@alexkroman1/aai/step` slot over the same
 * `AsyncLocalStorage`.
 *
 * These are the reader's own claims. That the number it reads is the REAL
 * attempt across a retry is `workflow-replay-step.test.ts`'s, because only the
 * engine can say so.
 */
describe("createStepInfoReader", () => {
  test("answers undefined outside a step, which a body reads as not retrying", async () => {
    const read = createStepInfoReader();
    expect(read()).toBeUndefined();
    // A workflow BODY is in a run and is not a step, and that is the case a
    // bare "is there a run" test would get wrong.
    await withRunContext({ runId: "wrun_1", workflow: "digest", write: async () => 1 }, async () =>
      expect(read()).toBeUndefined(),
    );
  });

  test("derives isLastAttempt with `>=`, so a burned boot cannot hide the last try", async () => {
    // `===` reads attempt 4 of 3 as "not the last one", and an attempt can be
    // burned by a failed boot — which is exactly when a body most wants to
    // degrade rather than fail.
    const read = createStepInfoReader();
    // Inside a RUN as well as a step: `withStepContext` narrows an existing
    // context and is a no-op without one, which is what makes a step's helpers
    // land in the step's own run rather than inventing one.
    await withRunContext({ runId: "wrun_1", workflow: "digest", write: async () => 1 }, async () =>
      withStepContext({ name: "charge", key: "charge#0", attempt: 4, maxAttempts: 3 }, () => {
        expect(read()).toEqual({
          name: "charge",
          key: "charge#0",
          attempt: 4,
          maxAttempts: 3,
          isLastAttempt: true,
        });
        return Promise.resolve();
      }),
    );
  });

  test("carries the KEY, so a loop's rounds are distinguishable", async () => {
    const read = createStepInfoReader();
    await withRunContext({ runId: "wrun_1", workflow: "digest", write: async () => 1 }, async () =>
      withStepContext({ name: "tick", key: "tick#2", attempt: 1, maxAttempts: 3 }, () => {
        expect(read()).toMatchObject({ key: "tick#2", isLastAttempt: false });
        return Promise.resolve();
      }),
    );
  });
});
