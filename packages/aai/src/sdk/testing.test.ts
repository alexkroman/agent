// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { publishStepReporter, stepEmit, stepReport } from "./step-report.ts";
import { createStubWorkflows, stubReporter } from "./testing.ts";

describe("createStubWorkflows", () => {
  test("an unstubbed method rejects naming itself rather than being undefined", async () => {
    const workflows = createStubWorkflows();
    await expect(workflows.start("digest", {})).rejects.toThrow(/not stubbed/);
    await expect(workflows.wakeUp("wrun_1")).rejects.toThrow(/not stubbed/);
    await expect(workflows.stream("wrun_1")).rejects.toThrow(/not stubbed/);
  });

  test("overrides win", async () => {
    const workflows = createStubWorkflows({ start: async () => "wrun_7" });
    await expect(workflows.start("digest", {})).resolves.toBe("wrun_7");
  });

  test("listing answers an empty list rather than throwing", () => {
    // Synchronous, so it cannot reject — and "this app declares none" is a
    // truthful answer for a stub.
    expect(createStubWorkflows().listing()).toEqual([]);
  });

  test("every method of the client is present", () => {
    // The whole point: a method added to `WorkflowClient` must arrive here
    // rather than being left `undefined` for whatever reaches it. Asserted as a
    // count-free presence check over the object's own keys, so this cannot pass
    // by the stub quietly shrinking.
    const workflows = createStubWorkflows();
    for (const [name, value] of Object.entries(workflows)) {
      expect(typeof value, name).toBe("function");
    }
    expect(Object.keys(workflows).sort()).toEqual([
      "cancel",
      "cancelAll",
      "find",
      "findByKey",
      "get",
      "lastLine",
      "listing",
      "publicWebhookUrl",
      "recent",
      "signal",
      "start",
      "stream",
      "streamTail",
      "wakeUp",
    ]);
  });

  test("publicWebhookUrl THROWS rather than answering an empty string", () => {
    // The other synchronous method, and it gets the opposite treatment from
    // `listing` above: there is no truthful empty answer for a URL, so a stub
    // that has not been given one must say so rather than hand back something a
    // test would then assert about.
    expect(() => createStubWorkflows().publicWebhookUrl("t")).toThrow(/not stubbed/);
  });
});

describe("stubReporter", () => {
  afterEach(() => publishStepReporter(undefined));

  test("separates the SENTENCES from the CHUNKS, the way the streams are", async () => {
    // The split is the helper's whole value: a spec asserting a partial result
    // never has to filter the narration out of it, and the test it applies is
    // the same one `stepEmit()`'s contract rests on — an absent namespace is the
    // default stream, which is `stepReport()`'s.
    const reported = stubReporter();
    await stepReport("Transcribing 0:00–0:58.");
    await stepEmit("transcript", { index: 0, text: "hello" });
    await stepReport("Transcribed 0:00–0:58 in 4.2s.");

    expect(reported.lines).toEqual(["Transcribing 0:00–0:58.", "Transcribed 0:00–0:58 in 4.2s."]);
    expect(reported.emitted).toEqual([
      { namespace: "transcript", chunk: { index: 0, text: "hello" } },
    ]);
  });

  test("keeps chunks from different streams apart, and in order", async () => {
    const reported = stubReporter();
    await stepEmit("transcript", "one");
    await stepEmit("costs", { usd: 0.02 });
    await stepEmit("transcript", "two");
    expect(reported.emitted.map((one) => one.namespace)).toEqual([
      "transcript",
      "costs",
      "transcript",
    ]);
  });

  test("restore unpublishes, so it cannot answer the next file's steps", async () => {
    const reported = stubReporter();
    reported.restore();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await stepReport("after");
    expect(reported.lines).toEqual([]);
    // Back to the console fallback, which is what an unpublished slot means.
    expect(spy).toHaveBeenCalled();
  });
});
