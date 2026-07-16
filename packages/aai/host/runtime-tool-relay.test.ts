// Copyright 2026 the AAI authors. MIT license.
/**
 * Regression tests for how `createRuntime` wires the pipeline transport's
 * `onToolCall` observability emit, which differs between in-process and relay
 * (host) mode. See the diagnosis in the commit that added this file.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "./_pipeline-test-fakes.ts";
import { makeAgent, makeClientSink, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

const toolCallStep = [
  [{ type: "tool-call" as const, toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
  [],
];

function toolCallEmits(client: ReturnType<typeof makeClientSink>) {
  return (client.event as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([e]) => (e as { type: string }).type === "tool_call",
  );
}

describe("createRuntime — pipeline onToolCall wiring", () => {
  test("relay mode does NOT emit an observability tool_call frame", async () => {
    // Regression: in host (relay) mode the relay executeTool already emits the
    // client-facing `tool_call` frame (host-mode.ts) — the client is the tool
    // executor. The pipeline `onToolCall` observability path used to ALSO emit
    // an identical `tool_call` frame, so the client received two and executed
    // the tool twice. On write tools the second execution errored against the
    // already-mutated state ("Non-delivered order cannot be exchanged"), which
    // the agent retried into a `too_many_errors` failure. See tau2 aai_run_10.
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    const client = makeClientSink();
    const exec = createRuntime({
      agent: makeAgent(),
      env: {},
      stt,
      tts,
      llm: createFakeLanguageModel({ steps: toolCallStep }),
      // executeTool + toolSchemas + onToolResult ⇒ relay mode.
      executeTool: vi.fn(async () => "ok"),
      onToolResult: vi.fn(),
      toolSchemas: [
        {
          type: "function",
          name: "lookup",
          description: "Look up",
          parameters: { type: "object" },
        },
      ],
      logger: silentLogger,
    });

    const core = exec.createSession({ id: "s1", agent: "test-agent", client, skipGreeting: true });
    await core.start();
    stt.last()?.fireFinal("Look it up.");
    await vi.waitFor(
      () => {
        expect(client.event).toHaveBeenCalledWith(expect.objectContaining({ type: "reply_done" }));
      },
      { timeout: 4000 },
    );
    await core.stop();

    expect(toolCallEmits(client)).toHaveLength(0);
  });

  test("in-process mode DOES emit exactly one observability tool_call frame", async () => {
    // Counterpart: a deployed pipeline agent executes tools in-process, so the
    // observability emit is the ONLY `tool_call` signal to the client and must
    // be preserved (exactly once).
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    const client = makeClientSink();
    const exec = createRuntime({
      agent: makeAgent({ tools: { lookup: { description: "Look up", execute: () => "ok" } } }),
      env: {},
      stt,
      tts,
      llm: createFakeLanguageModel({ steps: toolCallStep }),
      logger: silentLogger,
    });

    const core = exec.createSession({ id: "s1", agent: "test-agent", client, skipGreeting: true });
    await core.start();
    stt.last()?.fireFinal("Look it up.");
    await vi.waitFor(
      () => {
        expect(client.event).toHaveBeenCalledWith(expect.objectContaining({ type: "reply_done" }));
      },
      { timeout: 4000 },
    );
    await core.stop();

    const emits = toolCallEmits(client);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.[0]).toMatchObject({ type: "tool_call", toolCallId: "tc-1" });
  });
});
