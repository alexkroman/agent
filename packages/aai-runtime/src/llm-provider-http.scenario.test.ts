// Copyright 2026 the AAI authors. MIT license.
/**
 * An agent's LLM turn over REAL HTTP, against a local fake provider.
 *
 * Every keyless LLM test in this package replaces the `LanguageModel` itself —
 * `createFakeLanguageModel`, `createScriptedOneShotModel`, the `AAI_EVAL_STUB`
 * registry entry — so the code BETWEEN the runtime and the wire never runs in
 * them: `resolveLlm`'s factory, the `@ai-sdk/*` client, request serialization
 * (the system prompt, the tool schemas, the tool-result message), SSE parsing,
 * and `repairOpenAiStream` on the AssemblyAI gateway. A scripted model answers
 * a `doStream` call; this suite answers an HTTP request, so what it asserts is
 * what the runtime actually PUT ON THE WIRE and whether it survived the
 * provider's real streaming format coming back.
 *
 * `@copilotkit/aimock` is the server: one local port speaking the
 * OpenAI chat-completions and Anthropic Messages streaming dialects, matching
 * fixtures against the conversation, and journaling every request. The agent
 * is pointed at it through `llm({ baseUrl })` — the same option a user sets for
 * a self-hosted gateway — so nothing here is a test-only seam. Nothing on this
 * path is SSRF-checked (the LLM providers use the global `fetch`), which is
 * what lets a loopback URL through.
 *
 * Scenario tier because it binds a port. It needs no key and no network
 * beyond loopback, so it runs everywhere the tier does.
 */

import { agent, type SessionEvent, tool } from "@alexkroman1/aai";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, llm } from "@alexkroman1/aai/llm";
import { withTools } from "@alexkroman1/aai/manifest";
import { LLMock } from "@copilotkit/aimock";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { silentLogger } from "./_test-utils.ts";
import { createTextAgent } from "./text-agent.ts";

const QUESTION = "Where is order 42?";
const TOOL_CALL_ID = "call_lookup_42";
const REPLY = "Order 42 shipped yesterday and arrives Friday.";
const SYSTEM_PROMPT = "You answer order questions. Always look the order up first.";

let mock: LLMock;

beforeAll(async () => {
  mock = new LLMock({ port: 0 });
  // Registration order is match order, so the tool-result fixture goes FIRST:
  // the second request still has the question as its last USER message, and
  // would otherwise match the tool-call fixture again and loop.
  mock.onToolResult(TOOL_CALL_ID, { content: REPLY });
  mock.onMessage(QUESTION, {
    toolCalls: [{ id: TOOL_CALL_ID, name: "lookup_order", arguments: { id: "42" } }],
  });
  await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.clearRequests();
});

/** Drain a turn's text, which is also what drives the tool loop. */
async function drain(result: { textStream: AsyncIterable<string> }): Promise<string> {
  let out = "";
  for await (const delta of result.textStream) out += delta;
  return out;
}

/** A text agent with one tool, whose calls are recorded. */
function orderAgent(provider: Parameters<typeof llm>[0]) {
  const calls: unknown[] = [];
  const def = withTools(
    agent({ name: "Orders", text: true, systemPrompt: SYSTEM_PROMPT, llm: llm(provider) }),
    {
      lookup_order: tool({
        description: "Look up an order by id",
        inputSchema: z.object({ id: z.string() }),
        execute: (args) => {
          calls.push(args);
          return { status: "shipped", eta: "Friday" };
        },
      }),
    },
  );
  return { def, calls };
}

describe("an LLM turn over HTTP", () => {
  test("AssemblyAI gateway (chat completions, through repairOpenAiStream)", async () => {
    const { def, calls } = orderAgent({
      provider: "assemblyai",
      model: ASSEMBLYAI_LLM_DEFAULT_MODEL,
      baseUrl: `${mock.url}/v1`,
    });
    const chat = createTextAgent({
      agent: def,
      providerEnv: { ASSEMBLYAI_API_KEY: "test-key" },
      logger: silentLogger,
    });

    const text = await drain(chat.stream({ messages: [{ role: "user", content: QUESTION }] }));

    expect(text).toBe(REPLY);
    // The tool call was parsed out of the provider's SSE and the args survived.
    expect(calls).toEqual([{ id: "42" }]);

    const requests = mock.getRequests();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/chat/completions",
      "POST /v1/chat/completions",
    ]);
    // A credential was sent (aimock redacts its value in the journal). It can
    // only have come from providerEnv: nothing here sets a process.env key.
    expect(requests[0]?.headers.authorization).toBeDefined();

    const first = requests[0]?.body;
    expect(first?.stream).toBe(true);
    expect(first?.model).toBe(ASSEMBLYAI_LLM_DEFAULT_MODEL);
    const messages = first?.messages ?? [];
    // `developer`, not `system`: `@ai-sdk/openai` sends the system prompt under
    // that role for a reasoning-model id, and the default gateway model is one.
    // Nothing else in the repo shows this, since every other spec stops at the
    // `LanguageModel` prompt, where it is still `system`.
    expect(messages[0]?.role).toBe("developer");
    expect(String(messages[0]?.content)).toContain(SYSTEM_PROMPT);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: QUESTION });
    const tools = first?.tools ?? [];
    expect(tools.map((t) => t.function.name)).toContain("lookup_order");
    expect(
      tools.find((t) => t.function.name === "lookup_order")?.function.parameters,
    ).toMatchObject({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });

    // The second request answers the call, under the id the provider assigned.
    const second = requests[1]?.body?.messages ?? [];
    const answer = second.find((m) => m.role === "tool");
    expect(answer?.tool_call_id).toBe(TOOL_CALL_ID);
    expect(JSON.stringify(answer)).toContain("shipped");
  });

  test("Anthropic Messages", async () => {
    const { def, calls } = orderAgent({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      baseUrl: `${mock.url}/v1`,
    });
    const chat = createTextAgent({
      agent: def,
      providerEnv: { ANTHROPIC_API_KEY: "test-key" },
      logger: silentLogger,
    });

    const text = await drain(chat.stream({ messages: [{ role: "user", content: QUESTION }] }));

    expect(text).toBe(REPLY);
    expect(calls).toEqual([{ id: "42" }]);

    const requests = mock.getRequests();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/messages",
      "POST /v1/messages",
    ]);
    expect(requests[0]?.headers["x-api-key"]).toBeDefined();
    expect(requests[0]?.headers["anthropic-version"]).toBeTypeOf("string");
  });

  /** An AssemblyAI-gateway text agent over the mock, and its tool's calls. */
  function gatewayChat() {
    const events: SessionEvent[] = [];
    const { def, calls } = orderAgent({
      provider: "assemblyai",
      model: ASSEMBLYAI_LLM_DEFAULT_MODEL,
      baseUrl: `${mock.url}/v1`,
    });
    const chat = createTextAgent({
      agent: def,
      providerEnv: { ASSEMBLYAI_API_KEY: "test-key" },
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });
    return { chat, calls, events };
  }

  test("a transient 503 is retried and the turn completes", async () => {
    // A scripted model cannot produce an HTTP status at all, so the retry
    // policy under a real provider response had no test before this one.
    mock.nextRequestError(503, { message: "overloaded", type: "server_error" });
    const { chat, calls } = gatewayChat();

    const text = await drain(chat.stream({ messages: [{ role: "user", content: QUESTION }] }));

    expect(text).toBe(REPLY);
    expect(calls).toEqual([{ id: "42" }]);
    expect(mock.getRequests().map((r) => r.response.status)).toEqual([503, 200, 200]);
  });

  test("a 401 is not retried, and is REPORTED rather than read as silence", async () => {
    mock.nextRequestError(401, { message: "invalid api key", type: "invalid_request_error" });
    const { chat, calls, events } = gatewayChat();

    // The text stream just ends — it has no error channel — so a caller that
    // only drains it sees an empty reply. The event stream is where a failed
    // turn is visible, and this is the assertion that it stays visible.
    const text = await drain(chat.stream({ messages: [{ role: "user", content: QUESTION }] }));

    expect(text).toBe("");
    expect(calls).toEqual([]);
    expect(mock.getRequests().map((r) => r.response.status)).toEqual([401]);
    expect(events).toContainEqual(expect.objectContaining({ type: "error.reported", code: "llm" }));
  });
});
