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

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  getStepMetadata.mockReturnValue({ stepName: "transcribeSegment", stepId: "step_1", attempt: 1 });
});

describe("createStepReporter", () => {
  test("writes the line to the run's stream and to the log", async () => {
    const written = recordingStream();
    const log = logger();
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
    await createStepReporter(logger())("Transcribing 0:00–0:58.");
    expect(written).toEqual(["Transcribing 0:00–0:58. (attempt 3)"]);
  });

  test("says nothing extra on the first attempt", async () => {
    const written = recordingStream();
    await createStepReporter(logger())("Filing the findings.");
    expect(written).toEqual(["Filing the findings."]);
  });

  test("still logs when there is no step around it", async () => {
    // `getStepMetadata()` throws outside a step — a workflow body, a spec — and
    // that is a legitimate place to report from.
    getStepMetadata.mockImplementation(() => {
      throw new Error("not in a step");
    });
    const written = recordingStream();
    const log = logger();
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
    const log = logger();
    await expect(createStepReporter(log)("Still going.")).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("Workflow: Still going.", expect.anything());
    expect(log.debug).toHaveBeenCalledWith(
      "Workflow progress not streamed",
      expect.objectContaining({ error: expect.stringContaining("stream is gone") }),
    );
  });
});
