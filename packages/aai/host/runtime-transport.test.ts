// Copyright 2026 the AAI authors. MIT license.
// Transport-selection specs: what each mode's sessionConfig actually carries.
// The wire shape of those fields lives in s2s.test.ts.

import { describe, expect, test, vi } from "vitest";
import { assemblyAIS2s } from "../sdk/providers/s2s/assemblyai.ts";
import { makeAgent, silentLogger } from "./_test-utils.ts";
import { DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import { createTransportFactory } from "./runtime-transport.ts";
import * as pipelineTransport from "./transports/pipeline-transport.ts";
import { _internals } from "./transports/s2s-transport.ts";
import type { TransportCallbacks } from "./transports/types.ts";

async function buildS2sSessionConfig(agentOverrides: Record<string, unknown>) {
  const handle = {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(() => true),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
  };
  const connect = vi.spyOn(_internals, "connectS2s").mockResolvedValue(handle);
  const agent = makeAgent({ s2s: assemblyAIS2s(), ...agentOverrides });
  const build = createTransportFactory({
    agent,
    agentConfig: agent as never,
    toolSchemas: [],
    executeTool: vi.fn(),
    env: { ASSEMBLYAI_API_KEY: "k" },
    s2sConfig: DEFAULT_S2S_CONFIG,
    pipelineProviders: undefined,
    logger: silentLogger,
  } as never);
  const transport = build({
    sessionOpts: {
      id: "s1",
      agent: "a",
      client: { send: vi.fn(), sendAudio: vi.fn() } as never,
    },
    systemPrompt: "sp",
    callbacks: {} as TransportCallbacks,
  });
  // The connect is async — `updateSession` runs once it resolves, not at build.
  await transport.start();
  connect.mockRestore();
  return handle;
}

/**
 * `sttPrompt` used to be read only by the pipeline branch, so an S2S agent that
 * set one got unbiased transcription and no warning — the dropped-field bug
 * class the SDK guide warns about. This asserts the forwarding at the exact
 * point it was missing.
 */
describe("createTransportFactory (S2S)", () => {
  test("forwards sttPrompt into the S2S session config", async () => {
    const handle = await buildS2sSessionConfig({ sttPrompt: "Expect spelled names." });
    expect(handle.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sttPrompt: "Expect spelled names." }),
    );
  });

  test("omits sttPrompt entirely when the agent sets none", async () => {
    const handle = await buildS2sSessionConfig({});
    const sent = handle.updateSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("sttPrompt");
  });
});

/**
 * The same dropped-field class on the pipeline branch: `errorPhrase` reached
 * the agent definition and this builder never read it, so an agent that set one
 * (including `""` to disable) silently got the default. Every pipeline-only
 * field needs an assertion at this exact seam.
 */
describe("createTransportFactory (pipeline)", () => {
  test.each([
    ["preemptiveGeneration", true],
    ["errorPhrase", ""],
    ["resumeFalseInterruption", false],
  ])("forwards %s into createPipelineTransport", async (field, value) => {
    const build = vi
      .spyOn(pipelineTransport, "createPipelineTransport")
      .mockReturnValue({} as never);
    const agent = makeAgent({ [field]: value });
    const factory = createTransportFactory({
      agent,
      agentConfig: agent as never,
      toolSchemas: [],
      executeTool: vi.fn(),
      env: { ASSEMBLYAI_API_KEY: "k" },
      s2sConfig: DEFAULT_S2S_CONFIG,
      pipelineProviders: {
        stt: { opener: { name: "s", open: vi.fn() }, apiKey: "k" },
        tts: { opener: { name: "t", open: vi.fn() }, apiKey: "k" },
        llm: {} as never,
      },
      logger: silentLogger,
    } as never);
    factory({
      sessionOpts: {
        id: "s1",
        agent: "a",
        client: { send: vi.fn(), sendAudio: vi.fn() } as never,
      },
      systemPrompt: "sp",
      callbacks: {} as TransportCallbacks,
    });
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ [field]: value }));
  });
});
