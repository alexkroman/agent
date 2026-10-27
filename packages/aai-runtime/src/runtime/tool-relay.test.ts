// Copyright 2026 the AAI authors. MIT license.
/**
 * Regression tests for how `createRuntime` wires the pipeline transport's
 * `onToolCall` observability emit, which differs between in-process and relay
 * (host) mode. See the diagnosis in the commit that added this file.
 */

import { describe, expect, test, vi } from "vitest";
import { makeAgent } from "../_agent-test-utils.ts";
import { makeLogger, silentLogger } from "../_logger-test-utils.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  registerFakeProviders,
} from "../_pipeline-test-fakes.ts";
import { makeClientSink } from "../_session-test-utils.ts";
import { createRuntimeWithSeams } from "./runtime.ts";

const toolCallStep = [
  [{ type: "tool-call" as const, toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
  [],
];

function toolCallEmits(client: ReturnType<typeof makeClientSink>) {
  return (client.event as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([e]) => (e as { type: string }).type === "tool.called",
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
    const fakes = registerFakeProviders({
      stt,
      tts,
      llm: createFakeLanguageModel({ steps: toolCallStep }),
    });
    const client = makeClientSink();
    const exec = createRuntimeWithSeams({
      agent: makeAgent(),
      env: fakes.env,
      stt: fakes.stt,
      tts: fakes.tts,
      llm: fakes.llm,
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
        expect(client.event).toHaveBeenCalledWith(
          expect.objectContaining({ type: "reply.completed" }),
        );
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
    const fakes = registerFakeProviders({
      stt,
      tts,
      llm: createFakeLanguageModel({ steps: toolCallStep }),
    });
    const client = makeClientSink();
    const exec = createRuntimeWithSeams({
      agent: makeAgent({ tools: { lookup: { description: "Look up", execute: () => "ok" } } }),
      env: fakes.env,
      stt: fakes.stt,
      tts: fakes.tts,
      llm: fakes.llm,
      logger: silentLogger,
    });

    const core = exec.createSession({ id: "s1", agent: "test-agent", client, skipGreeting: true });
    await core.start();
    stt.last()?.fireFinal("Look it up.");
    await vi.waitFor(
      () => {
        expect(client.event).toHaveBeenCalledWith(
          expect.objectContaining({ type: "reply.completed" }),
        );
      },
      { timeout: 4000 },
    );
    await core.stop();

    const emits = toolCallEmits(client);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.[0]).toMatchObject({ type: "tool.called", toolCallId: "tc-1" });
  });
});

/**
 * The relay pair is `executeTool` + `toolSchemas`, and `setupTools` dispatches on
 * BOTH — so half a pair does not half-work, it silently selects the other mode
 * and discards the option that was passed. That is the shape this PR paid for
 * four times over (a dropped `options.signal`, a deleted `dataDir`, `streams`
 * falling back to memory, a removed `workflowWorldStarted` guard), and the doc on
 * `RuntimeOptions.toolSchemas` has said "Required when `executeTool` is provided"
 * the whole time.
 */
describe("createRuntime — the relay pair must be whole", () => {
  test("executeTool without toolSchemas is REFUSED, not silently ignored", () => {
    expect(() =>
      createRuntimeWithSeams({
        agent: makeAgent(),
        env: {},
        executeTool: vi.fn(async () => "relayed"),
        logger: silentLogger,
      }),
    ).toThrow(/toolSchemas/);
  });

  test("toolSchemas without executeTool is REFUSED, not silently ignored", () => {
    expect(() =>
      createRuntimeWithSeams({
        agent: makeAgent(),
        env: {},
        toolSchemas: [{ type: "function", name: "lookup", description: "Look up", parameters: {} }],
        logger: silentLogger,
      }),
    ).toThrow(/executeTool/);
  });
});

describe("createRuntime — host builtins in relay mode", () => {
  // The client is sent a `tool.called` only for a tool it must run, so a host
  // builtin (think) left no trace a relay harness could read. The log line is
  // the record, and the call must still not be relayed.
  test("a think call runs on the host and is logged, not relayed", async () => {
    const relay = vi.fn(async () => "relayed");
    const logger = makeLogger();
    const exec = createRuntimeWithSeams({
      // `think` is opt-in (DEFAULT_BUILTIN_TOOLS is empty), so it is named.
      agent: { ...makeAgent(), builtinTools: ["think"] },
      env: {},
      executeTool: relay,
      onToolResult: vi.fn(),
      toolSchemas: [],
      logger,
    });
    expect(await exec.executeTool("think", { thought: "Policy: confirm first." }, "s1", [])).toBe(
      "ok",
    );
    expect(relay).not.toHaveBeenCalled();
    const lines = logger.info.mock.calls.filter(([m]) => m === "Host builtin tool");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatchObject({ sid: "s1", tool: "think" });
  });
});
