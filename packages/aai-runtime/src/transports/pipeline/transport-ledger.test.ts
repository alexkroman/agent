// Copyright 2026 the AAI authors. MIT license.
// The ledger rides a session only when its tool set DECLARES a write — see
// `history/ledger.ts`. These specs drive a real transport through a turn with a
// lookup and assert on the NEXT request the model is sent.

import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../../_pipeline-test-fakes.ts";
import {
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "../_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./transport.ts";

useVirtualTime();

const LOOKUP: ScriptedPart = {
  type: "tool-call",
  toolCallId: "c1",
  toolName: "lookup",
  input: "{}",
};

const writeSchema: ToolSchema = {
  type: "function",
  name: "cancel",
  description: "Cancel something.",
  parameters: { type: "object", properties: {}, required: [] },
  annotations: { readOnlyHint: false },
};

/** The last message of the request sent on the second turn. */
async function secondTurnTail(
  toolSchemas: ToolSchema[],
): Promise<{ role: string; content: unknown }> {
  const { opts, stt } = makeOpts({
    llm: createFakeLanguageModel({
      steps: [[LOOKUP], [{ type: "text", text: "Found it." }], [{ type: "text", text: "Sure." }]],
      delayMs: 10,
    }),
    executeTool: vi.fn(async () => '{"status":"delivered"}'),
    toolSchemas,
  });
  const t = createPipelineTransport(opts);
  await t.start();
  stt.last()?.fireFinal("look up my order");
  await vi.advanceTimersByTimeAsync(2000);
  stt.last()?.fireFinal("thanks");
  await vi.waitFor(() => {
    if (llmCalls(opts).calls.length < 3) throw new Error("no second-turn request yet");
  });
  await vi.advanceTimersByTimeAsync(500);
  const prompt = (llmCalls(opts).calls.at(-1)?.prompt ?? []) as {
    role: string;
    content: unknown;
  }[];
  await t.stop();
  const tail = prompt.at(-1);
  if (tail === undefined) throw new Error("second request sent no prompt");
  return tail;
}

describe("the ledger", () => {
  test("rides a session whose tools declare a write, after the newest turn", async () => {
    const tail = await secondTurnTail([noopToolSchema, writeSchema]);
    expect(tail.role).toBe("system");
    expect(String(tail.content)).toContain('<record source="lookup()">');
    expect(String(tail.content)).toContain('{"status":"delivered"}');
  });

  test("is never sent when no tool declares a write", async () => {
    const tail = await secondTurnTail([noopToolSchema]);
    expect(tail.role).toBe("user");
  });
});
