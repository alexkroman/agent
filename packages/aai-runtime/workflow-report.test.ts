// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the published reporter — the half that turns one `report()` into a
 * stream chunk AND a server-log line.
 *
 * The DevKit is mocked because the subject is what this module does with it: a
 * real `getWritable()` needs a run, which is exactly the thing a spec cannot
 * have. What is asserted is the ORDER (the log first, since a stream write can
 * fail and an operator still wants the line), the attempt suffix, and that a
 * failing stream never propagates.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";

const getWritable = vi.fn();
const getStepMetadata = vi.fn();

vi.mock("workflow", () => ({
  get getWritable() {
    return getWritable;
  },
  get getStepMetadata() {
    return getStepMetadata;
  },
}));

const { createStepReporter } = await import("./workflow-report.ts");

/** A writable that records what was written to it. */
function recordingStream(over: { write?: () => Promise<void> } = {}) {
  const written: string[] = [];
  getWritable.mockReturnValue({
    getWriter: () => ({
      write: over.write ?? (async (line: string) => void written.push(line)),
      releaseLock: vi.fn(),
    }),
  });
  return written;
}

/**
 * A writable per NAMESPACE, so a spec can assert which stream a chunk landed in.
 *
 * The key is the whole subject for `emit()`: the DevKit keys a run's streams by
 * namespace, and a chunk written to the default one is a chunk in the middle of
 * the progress log.
 */
function recordingStreams() {
  const streams = new Map<string, unknown[]>();
  getWritable.mockImplementation((options?: { namespace?: string }) => {
    const key = options?.namespace ?? "";
    const written = streams.get(key) ?? [];
    streams.set(key, written);
    return {
      getWriter: () => ({
        write: async (chunk: unknown) => void written.push(chunk),
        releaseLock: vi.fn(),
      }),
    };
  });
  return streams;
}

beforeEach(() => {
  getStepMetadata.mockReturnValue({ stepName: "transcribeSegment", stepId: "step_1", attempt: 1 });
});

describe("createStepReporter", () => {
  test("writes the line to the run's stream and to the log", async () => {
    const written = recordingStream();
    const log = makeLogger();
    await createStepReporter(log)("Transcribing 0:00–0:58.");
    expect(written).toEqual(["Transcribing 0:00–0:58."]);
    expect(log.info).toHaveBeenCalledWith(
      "Workflow: Transcribing 0:00–0:58.",
      expect.objectContaining({ step: "transcribeSegment", attempt: 1 }),
    );
  });

  test("NAMES the attempt past the first, in the line a page renders", async () => {
    // A fan-out that is retrying looks identical to one that is succeeding —
    // the same sentence, sixty times — unless the attempt is in the line.
    getStepMetadata.mockReturnValue({ stepName: "transcribeSegment", stepId: "s", attempt: 3 });
    const written = recordingStream();
    await createStepReporter(makeLogger())("Transcribing 0:00–0:58.");
    expect(written).toEqual(["Transcribing 0:00–0:58. (attempt 3)"]);
  });

  test("says nothing extra on the first attempt", async () => {
    const written = recordingStream();
    await createStepReporter(makeLogger())("Filing the findings.");
    expect(written).toEqual(["Filing the findings."]);
  });

  test("still logs when there is no step around it", async () => {
    // `getStepMetadata()` throws outside a step — a workflow body, a spec — and
    // that is a legitimate place to report from.
    getStepMetadata.mockImplementation(() => {
      throw new Error("not in a step");
    });
    const written = recordingStream();
    const log = makeLogger();
    await createStepReporter(log)("Planning.");
    expect(written).toEqual(["Planning."]);
    expect(log.info).toHaveBeenCalledWith("Workflow: Planning.", {});
  });

  test("keeps the log line when the stream write fails", async () => {
    // The reader that cannot go away is the operator; a page that closed
    // mid-run is the ordinary case, which is why this is a debug and not a warn.
    recordingStream({
      write: () => Promise.reject(new Error("stream is gone")),
    });
    const log = makeLogger();
    await expect(createStepReporter(log)("Still going.")).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("Workflow: Still going.", expect.anything());
    expect(log.debug).toHaveBeenCalledWith(
      "Workflow progress not streamed",
      expect.objectContaining({ error: expect.stringContaining("stream is gone") }),
    );
  });
});

describe("a chunk emitted into a named stream", () => {
  test("goes to THAT stream and not to the default one", async () => {
    const streams = recordingStreams();
    const log = makeLogger();
    await createStepReporter(log)(
      { index: 3, text: "and then we shipped it" },
      { namespace: "transcript", log: false },
    );
    expect(streams.get("transcript")).toEqual([{ index: 3, text: "and then we shipped it" }]);
    // The default stream is `report()`'s, and an object in it renders as
    // `[object Object]` in the middle of a page's progress log.
    expect(streams.get("")).toBeUndefined();
  });

  test("is not logged, so a chunk per segment cannot bury the narration", async () => {
    recordingStreams();
    const log = makeLogger();
    await createStepReporter(log)({ index: 3 }, { namespace: "transcript", log: false });
    expect(log.info).not.toHaveBeenCalled();
  });

  test("takes NO attempt suffix — a chunk is parsed, not read", async () => {
    // The suffix is what tells a human reader a fan-out is retrying. Appended to
    // a value it is either lost or corruption, and the narration beside it is
    // where a retry is already visible.
    getStepMetadata.mockReturnValue({ stepName: "transcribeSegment", stepId: "s", attempt: 3 });
    const streams = recordingStreams();
    await createStepReporter(makeLogger())(
      { text: "hello" },
      { namespace: "transcript", log: false },
    );
    expect(streams.get("transcript")).toEqual([{ text: "hello" }]);
  });

  test("names the stream when a write is lost", async () => {
    getWritable.mockImplementation(() => ({
      getWriter: () => ({
        write: () => Promise.reject(new Error("stream is gone")),
        releaseLock: vi.fn(),
      }),
    }));
    const log = makeLogger();
    await expect(
      createStepReporter(log)({ index: 1 }, { namespace: "transcript", log: false }),
    ).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalledWith(
      "Workflow progress not streamed",
      expect.objectContaining({ namespace: "transcript" }),
    );
  });

  test("a LINE still goes to the default stream, with its attempt suffix", async () => {
    // The other half of the same reporter, unchanged: `report()` passes no
    // namespace, and `getWritable` distinguishes that from an explicit one.
    getStepMetadata.mockReturnValue({ stepName: "transcribeSegment", stepId: "s", attempt: 2 });
    const streams = recordingStreams();
    const log = makeLogger();
    await createStepReporter(log)("Transcribing 0:00–0:58.", { log: true });
    expect(streams.get("")).toEqual(["Transcribing 0:00–0:58. (attempt 2)"]);
    expect(log.info).toHaveBeenCalled();
  });
});
