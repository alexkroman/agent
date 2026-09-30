// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishStepEnv } from "./step-env.ts";
import { type ClientNotifier, publishClientNotifier } from "./step-notify-client.ts";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS } from "./step-say-on-client.ts";
import { publishSpeechSynthesizer } from "./step-speak.ts";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";

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
  test("is one step under its name, with the delivery budget and the run id", async () => {
    const ctx = createWorkflowContext({ runId: "wrun_1" });
    const said = await ctx.sayOnClient("announce", "speaker", {
      event: "reminder",
      text: "Reminder: feed Biscuit",
      data: { text: "feed Biscuit" },
    });
    expect(said).toBe("Reminder: feed Biscuit");
    expect(ctx.steps).toEqual([
      { name: "announce", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    ]);
    const [clientId, notice] = notify.mock.calls[0] ?? [];
    expect(clientId).toBe("speaker");
    expect(notice).toMatchObject({
      id: "wrun_1",
      event: "reminder",
      data: { text: "feed Biscuit", said: "Reminder: feed Biscuit" },
    });
  });

  test("an explicit id and maxAttempts override the defaults", async () => {
    const ctx = createWorkflowContext({ runId: "wrun_2" });
    await ctx.sayOnClient("progress", "speaker", {
      id: "wrun_2:progress",
      event: "app",
      text: "Halfway there.",
      maxAttempts: 4,
    });
    expect(ctx.steps).toEqual([{ name: "progress", maxAttempts: 4 }]);
    expect(notify.mock.calls[0]?.[1]).toMatchObject({ id: "wrun_2:progress" });
    // `maxAttempts` is the step's, never part of the notice.
    expect(notify.mock.calls[0]?.[1]).not.toHaveProperty("maxAttempts");
  });

  test("a step result stubbed by name answers it, as for any step", async () => {
    const ctx = createWorkflowContext({ results: { announce: "stubbed" } });
    expect(await ctx.sayOnClient("announce", "speaker", { event: "e", text: "hi" })).toBe(
      "stubbed",
    );
    expect(notify).not.toHaveBeenCalled();
  });
});
