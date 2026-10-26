// Copyright 2026 the AAI authors. MIT license.
/**
 * A `withInstruction` below a result's top level, end to end: a text agent
 * running a scripted model, the client's `tool.completed` frame read off
 * `onEvent`, and the model's copy read off the prompt the next step receives.
 *
 * The strip used to be top-level only, so a tool answering a LIST of
 * `withInstruction` rows handed the page the reserved key as data and the
 * model a `$instruction` column in the rows table, with no `[instruction]`
 * line at all.
 */
import { type AgentDef, agent, type SessionEvent, tool, withInstruction } from "@alexkroman1/aai";
import { type ToolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { expect, test } from "vitest";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { silentLogger } from "../_logger-test-utils.ts";
import { createTextAgent } from "../text-agent/index.ts";
import { TOOL_INSTRUCTION_LABEL } from "./result-instruction.ts";

function textAgent(tools: ToolRegistry): AgentDef {
  return withTools(agent({ name: "Desk", mode: "text", systemPrompt: "Be brief." }), tools);
}

/** The text a tool message carries in a model call's prompt. */
function toolResultText(call: Record<string, unknown> | undefined): string {
  const prompt = call?.prompt as readonly { role: string; content: unknown }[];
  const toolMessage = prompt.find((m) => m.role === "tool");
  const parts = toolMessage?.content as readonly { output: { value: unknown } }[];
  return String(parts[0]?.output.value);
}

test("rows carrying withInstruction reach the page stripped and the model once, as the [instruction] line", async () => {
  // `scriptedTextModel` is this fake with the parts projected for it; the
  // fake is driven directly so the prompt of the SECOND call — the model's
  // copy of the tool result — can be read back.
  const model = createFakeLanguageModel({
    steps: [
      [{ type: "tool-call", toolCallId: "c1", toolName: "list_rows", input: "{}" }],
      [{ type: "text", text: "done" }],
    ],
  });
  const events: SessionEvent[] = [];
  const chat = createTextAgent({
    agent: textAgent({
      list_rows: tool({
        description: "List",
        execute: () => ({
          rows: [1, 2].map((id) => withInstruction({ id, name: `row ${id}` }, "Name the count.")),
          note: withInstruction({ ok: true }, "Then stop."),
        }),
      }),
    }),
    model,
    logger: silentLogger,
    onEvent: (event) => events.push(event),
  });
  const result = chat.stream({ messages: [{ role: "user", content: "hi" }] });
  for await (const _ of result.textStream) {
    // drained
  }

  const completed = events.find((e) => e.type === "tool.completed");
  expect(completed).toMatchObject({
    type: "tool.completed",
    result: '{"rows":[{"id":1,"name":"row 1"},{"id":2,"name":"row 2"}],"note":{"ok":true}}',
  });
  const forModel = toolResultText(model.calls[1]);
  expect(forModel).not.toContain("$instruction");
  expect(forModel.endsWith(`\n\n${TOOL_INSTRUCTION_LABEL} Name the count. Then stop.`)).toBe(true);
  expect(forModel.split(TOOL_INSTRUCTION_LABEL)).toHaveLength(2);
});
