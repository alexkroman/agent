// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.sayOnClient` through the real replay engine: one journaled step under
 * the name the body gave, delivered under the run id, and answered from the
 * journal on a replay rather than said twice.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import {
  type ClientNotifier,
  publishClientNotifier,
  publishSpeechSynthesizer,
  publishStepEnv,
} from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { harness } from "./_engine-harness.ts";

let notify: ReturnType<typeof vi.fn<ClientNotifier>>;

beforeEach(() => {
  publishStepEnv({ ASSEMBLYAI_API_KEY: "test-key" });
  publishSpeechSynthesizer(async ({ text }) => new TextEncoder().encode(text));
  notify = vi.fn<ClientNotifier>(async () => "acked");
  publishClientNotifier(notify);
});

afterEach(() => {
  publishClientNotifier(undefined);
  publishSpeechSynthesizer(undefined);
  publishStepEnv(undefined);
});

describe("ctx.sayOnClient", () => {
  test("journals one step under its name and delivers under the run id", async () => {
    const { engine, journal } = harness({
      call: async (_input, ctx: WorkflowContext) =>
        await ctx.sayOnClient("announce", "speaker", { event: "reminder", text: "Time to go." }),
    });
    const runId = await engine.start("call", [{}]);
    expect(await engine.execute(runId)).toBe("completed");
    expect((await engine.getRun(runId))?.output).toBe("Time to go.");
    expect((await journal.readSteps(runId)).map((s) => s.key)).toEqual(["announce#0"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toMatchObject({ id: runId, event: "reminder" });
  });
});
