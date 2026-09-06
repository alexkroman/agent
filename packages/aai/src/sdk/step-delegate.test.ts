// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the `stepDelegate` SLOT — that a published runner is what a
 * step reaches, that an unpublished one fails in a way an author can act on,
 * and that the stub gives the slot back.
 *
 * The RUNNER's behaviour is `aai-runtime`'s (`step-delegate.test.ts` there, and
 * `subagent.test.ts` under it). What this file owns is the seam.
 */

import { afterEach, describe, expect, it } from "vitest";
import { publishStepDelegate, stepDelegate } from "./step-delegate.ts";
import { subagent } from "./subagent.ts";
import { stubStepDelegate } from "./testing-delegate.ts";

const researcher = subagent({ name: "researcher", systemPrompt: "Research it." });

afterEach(() => publishStepDelegate(undefined));

describe("stepDelegate", () => {
  it("hands the subagent and the options to the published runner", async () => {
    const seen: { name: string; task: string; context?: string }[] = [];
    publishStepDelegate((sub, options) => {
      seen.push({ name: sub.name, ...options });
      return Promise.resolve({
        text: "found it",
        steps: 2,
        toolCalls: [],
        revisions: 0,
        accepted: true,
      });
    });

    const result = await stepDelegate(researcher, {
      task: "battery prices",
      context: "for a brief",
    });

    expect(result).toMatchObject({ text: "found it", steps: 2 });
    expect(seen).toEqual([{ name: "researcher", task: "battery prices", context: "for a brief" }]);
  });

  it("rejects with the fix when nothing has published, naming the subagent", async () => {
    // A silent degrade is what this refuses to be: an empty result is
    // indistinguishable from a researcher that found nothing, and that is the
    // failure the whole mechanism exists to prevent.
    await expect(stepDelegate(researcher, { task: "x" })).rejects.toThrow(
      /stepDelegate\("researcher"\): no runner is published/,
    );
    await expect(stepDelegate(researcher, { task: "x" })).rejects.toThrow(
      /installStubStepDelegate/,
    );
  });

  it("REJECTS rather than throwing synchronously", async () => {
    // The contract is a promise, so a step's `try`/`catch` around an `await`
    // catches the unpublished case like any other delegation failure — a sync
    // throw would escape a `Promise.allSettled` and sink a whole fan-out.
    const returned = stepDelegate(researcher, { task: "x" });
    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toThrow();
  });

  it("publishing again REPLACES, and undefined unpublishes", async () => {
    publishStepDelegate(() =>
      Promise.resolve({ text: "first", steps: 1, toolCalls: [], revisions: 0, accepted: true }),
    );
    publishStepDelegate(() =>
      Promise.resolve({ text: "second", steps: 1, toolCalls: [], revisions: 0, accepted: true }),
    );
    expect((await stepDelegate(researcher, { task: "x" })).text).toBe("second");

    publishStepDelegate(undefined);
    await expect(stepDelegate(researcher, { task: "x" })).rejects.toThrow(/no runner is published/);
  });
});

describe("stubStepDelegate", () => {
  it("fills the slot and records what the step asked for", async () => {
    const desk = stubStepDelegate({ researcher: "Prices fell 12% in 2025." });

    const result = await stepDelegate(researcher, { task: "battery prices" });

    expect(result.text).toBe("Prices fell 12% in 2025.");
    expect(desk.calls).toHaveLength(1);
    expect(desk.calls[0]?.subagent.name).toBe("researcher");
    expect(desk.calls[0]?.task).toBe("battery prices");
  });

  it("gives the slot back, so one file's stub cannot answer the next one's step", async () => {
    const desk = stubStepDelegate({ researcher: "x" });
    desk.restore();
    await expect(stepDelegate(researcher, { task: "x" })).rejects.toThrow(/no runner is published/);
  });

  it("routes by subagent name, exactly as the tool-side stub does", async () => {
    const desk = stubStepDelegate({ researcher: "a finding", checker: "Confirmed: yes." });
    const checker = subagent({ name: "checker", systemPrompt: "Check it." });

    expect((await stepDelegate(researcher, { task: "x" })).text).toBe("a finding");
    expect((await stepDelegate(checker, { task: "y" })).text).toBe("Confirmed: yes.");
    await expect(
      stepDelegate(subagent({ name: "unrouted", systemPrompt: "?" }), { task: "z" }),
    ).rejects.toThrow(/no route for subagent "unrouted"/);
    expect(desk.calls).toHaveLength(3);
  });
});
