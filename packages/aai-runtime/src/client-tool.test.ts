// Copyright 2026 the AAI authors. MIT license.
/**
 * A `clientTool` end to end through the socket: the session emits the
 * ordinary `tool.called`, the page's `tool_result` frame goes through the
 * command dispatcher to the broker, and the call completes with the page's
 * answer — the self-hosted twin of host mode's relay spec in `host-mode.test.ts`.
 */

import { clientTool } from "@alexkroman1/aai";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { MockWebSocket } from "./_mock-ws.ts";
import {
  makeAgent,
  makeConfig,
  makeEmitter,
  makeLogger,
  makeSpeech,
  silentLogger,
} from "./_test-utils.ts";
import { createClientToolBroker } from "./client-tool-broker.ts";
import { setupTools } from "./runtime-tools.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import { createMemoryStateBackend, createSessionStateStore } from "./session-state/store.ts";
import type { Transport } from "./transports/types.ts";
import type { UsageMeter } from "./usage-meter.ts";
import { wireSessionSocket } from "./ws-handler.ts";

function makeFakeTransport(): Transport {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

describe("clientTool over a session socket", () => {
  test("the page's tool_result completes the call the session announced", async () => {
    const agent = makeAgent({
      tools: {
        get_location: clientTool({
          description: "the caller's location",
          inputSchema: z.object({ precise: z.boolean() }),
        }),
      },
    });
    const clientTools = createClientToolBroker();
    const { executeTool } = setupTools({
      agent,
      options: { agent, env: {} },
      llm: undefined,
      env: {},
      providerEnv: {},
      workflows: undefined,
      logger: silentLogger,
      emitters: createOwnedMap<string, SessionEmitter>(),
      meters: createOwnedMap<string, UsageMeter>(),
      speech: { of: () => makeSpeech() },
      clientTools,
      stateStore: createSessionStateStore({ backend: createMemoryStateBackend() }),
    });
    const ws = new MockWebSocket("ws://test");
    const transport = makeFakeTransport();
    const logger = makeLogger();

    let core: ReturnType<typeof createSessionCore> | undefined;
    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      logger,
      readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
      createSession: (_sid, client) => {
        core = createSessionCore({
          id: "s1",
          agent: "agent",
          client,
          emitter: makeEmitter(client, { sessionId: "s1" }).emitter,
          agentConfig: makeConfig(),
          executeTool,
          transport,
          clientTools,
          logger: silentLogger,
        });
        return core;
      },
    });
    await vi.waitFor(() => {
      expect(logger.info.mock.calls.map((c) => c[0])).toContain("Session ready");
    });
    if (!core) throw new Error("session core was not created");

    // The model calls the tool, as an S2S transport reports it.
    core.onReplyStarted("r1");
    core.report({
      type: "tool.called",
      toolCallId: "call-1",
      toolName: "get_location",
      args: { precise: true },
    });

    // The page sees the ordinary announcement — exactly once — and nothing more yet.
    expect(ws.sentJson().filter((m) => m.type === "tool.called")).toEqual([
      expect.objectContaining({ toolCallId: "call-1", toolName: "get_location" }),
    ]);
    expect(ws.sentJson().some((m) => m.type === "tool.completed")).toBe(false);

    ws.simulateMessage(
      JSON.stringify({
        type: "tool_result",
        toolCallId: "call-1",
        result: JSON.stringify({ lat: 59.9, lon: 10.7 }),
      }),
    );

    await vi.waitFor(() => {
      const done = ws.sentJson().find((m) => m.type === "tool.completed");
      expect(done).toMatchObject({ toolCallId: "call-1" });
      expect(JSON.parse(String(done?.result))).toEqual({ lat: 59.9, lon: 10.7 });
    });
  });
});
