// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { sayFailureOnClient } from "./say-failure-on-client.ts";
import { publishStepEnv } from "./step-env.ts";
import { type ClientNotifier, publishClientNotifier } from "./step-notify-client.ts";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS } from "./step-say-on-client.ts";
import { publishSpeechSynthesizer } from "./step-speak.ts";
import { workflow } from "./workflow.ts";
import { resolveFailureHandler } from "./workflow-failure.ts";

// The success half, `ctx.sayOnClient`, is pinned in `workflow-say-on-client.test.ts`.

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

describe("sayFailureOnClient", () => {
  type Input = { clientId?: string | undefined; topic: string };
  const handler = sayFailureOnClient<Input>({
    clientId: (input) => input.clientId,
    event: "research",
    text: (_err, input, reason) => `The research on ${input.topic} didn't finish. ${reason}`,
    data: (input) => ({ topic: input.topic }),
  });

  test("says the reason with the failure's id and data.failed, on the delivery budget", async () => {
    expect(handler.maxAttempts).toBe(DEFAULT_CLIENT_DELIVERY_ATTEMPTS);
    await handler.run(new Error("Gateway timed out. Retry at https://x.test/?key=sk-1"), {
      runId: "wrun_9",
      workflow: "research",
      input: { clientId: "speaker", topic: "tides" },
    });
    const [clientId, notice] = notify.mock.calls[0] ?? [];
    expect(clientId).toBe("speaker");
    expect(notice).toMatchObject({
      id: "wrun_9:failed",
      event: "research",
      data: {
        topic: "tides",
        failed: true,
        said: "The research on tides didn't finish. Gateway timed out.",
      },
    });
  });

  test("is a no-op when the input names no device", async () => {
    for (const clientId of [undefined, ""]) {
      await handler.run(new Error("boom"), {
        runId: "wrun_9",
        workflow: "research",
        input: { clientId, topic: "tides" },
      });
    }
    expect(notify).not.toHaveBeenCalled();
  });

  test("a static data record and a maxAttempts override", async () => {
    const custom = sayFailureOnClient<{ id: string }>({
      clientId: (input) => input.id,
      event: "email",
      text: () => "I couldn't email you.",
      data: { kind: "email" },
      maxAttempts: 3,
    });
    expect(resolveFailureHandler(custom)?.maxAttempts).toBe(3);
    await custom.run(new Error("x"), { runId: "r", workflow: "email", input: { id: "speaker" } });
    expect(notify.mock.calls[0]?.[1]).toMatchObject({
      data: { kind: "email", failed: true },
    });
  });

  test("is accepted by workflow({ onFailure }), and the engine takes it", () => {
    const schema = z.object({ clientId: z.string().optional(), topic: z.string() });
    const def = workflow({
      input: schema,
      run: async ({ topic }) => topic,
      // The type argument is required: tsc cannot infer a nested generic call's
      // parameter through `workflow()`'s own inference of the schema.
      onFailure: sayFailureOnClient<z.infer<typeof schema>>({
        clientId: (input) => input.clientId,
        event: "research",
        text: (_err, input, reason) => `${input.topic}: ${reason}`,
      }),
    });
    expect(resolveFailureHandler(def.onFailure)?.maxAttempts).toBe(
      DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
    );
  });
});
