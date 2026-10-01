// Copyright 2026 the AAI authors. MIT license.
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { makeAgent } from "../_agent-test-utils.ts";
import { silentLogger } from "../_logger-test-utils.ts";
import { makeClientSink } from "../_session-test-utils.ts";
import { createSessionDirectory } from "../session/index.ts";
import { createClientToolBroker } from "../tools/index.ts";
import { ASSEMBLYAI_S2S_CAPABILITIES } from "../transports/capabilities.ts";
import type { Transport } from "../transports/types.ts";
import { createSessionFactory } from "./session-factory.ts";
import { createRuntimeSessionState } from "./session-state.ts";
import { createSystemPromptResolver } from "./system-prompt.ts";
import type { BuildTransportArgs } from "./transport.ts";

function fakeTransport(): Transport {
  return {
    capabilities: ASSEMBLYAI_S2S_CAPABILITIES,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

function harness() {
  const agent = makeAgent({ name: "Factory", systemPrompt: "You are the factory agent." });
  const agentConfig = toAgentConfig(agent);
  const sessionState = createRuntimeSessionState({ db: undefined, logger: silentLogger });
  const sessions = createSessionDirectory();
  const transport = fakeTransport();
  const buildTransport = vi.fn((_args: BuildTransportArgs) => transport);
  const executeTool = vi.fn<ExecuteTool>(async () => "ok");
  const createSession = createSessionFactory({
    agent,
    env: {},
    agentConfig,
    logger: silentLogger,
    sessionState,
    sessions,
    systemPrompts: createSystemPromptResolver({
      agentConfig,
      hasTools: false,
      toolGuidance: undefined,
    }),
    buildTransport,
    tools: { executeTool, toolSchemas: [] },
    clientTools: createClientToolBroker(),
    relayToolResult: undefined,
    recall: {
      agent,
      env: {},
      workflows: undefined,
      logger: silentLogger,
      history: sessionState.history,
    },
  });
  return { createSession, buildTransport, transport, sessions, sessionState };
}

describe("createSessionFactory", () => {
  test("builds one transport per session, handed the session's own options", () => {
    const h = harness();
    const client = makeClientSink();
    const core = h.createSession({ id: "s-1", agent: "Factory", client, skipGreeting: false });
    expect(core.id).toBe("s-1");
    expect(h.buildTransport).toHaveBeenCalledTimes(1);
    const args = h.buildTransport.mock.calls[0]?.[0];
    expect(args?.sessionOpts).toMatchObject({ id: "s-1", agent: "Factory", client });
    // The greeting is composed HERE, once, and rides the session options.
    expect(args?.sessionOpts).toHaveProperty("greeting");
  });

  test("the system prompt is a THUNK over the session's prompt, not a captured string", () => {
    const h = harness();
    h.createSession({ id: "s-1", agent: "Factory", client: makeClientSink() });
    const prompt = h.buildTransport.mock.calls[0]?.[0].systemPrompt;
    expect(typeof prompt).toBe("function");
    expect(typeof prompt === "function" ? prompt() : prompt).toContain(
      "You are the factory agent.",
    );
  });

  test("the transport's callbacks are a flat forward into the session it built", () => {
    const h = harness();
    const client = makeClientSink();
    h.createSession({ id: "s-1", agent: "Factory", client });
    const callbacks = h.buildTransport.mock.calls[0]?.[0].callbacks;
    callbacks?.report({ type: "userTranscript.committed", text: "hello" });
    expect(client.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "userTranscript.committed", text: "hello" }),
    );
    callbacks?.onAudioChunk(new Uint8Array([1, 2]));
    expect(client.playAudioChunk).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  });

  test("the session's wiring is claimed in the directory under its id", () => {
    const h = harness();
    h.createSession({ id: "s-1", agent: "Factory", client: makeClientSink() });
    expect(h.sessions.emitter("s-1")).toBeDefined();
    expect(h.sessions.emitter("s-other")).toBeUndefined();
  });

  test("a resume under the same id cancels the sweep the previous stop scheduled", () => {
    const h = harness();
    const cancel = vi.spyOn(h.sessionState.sweeps, "cancel");
    h.createSession({ id: "s-1", agent: "Factory", client: makeClientSink() });
    expect(cancel).toHaveBeenCalledWith("s-1");
  });
});
