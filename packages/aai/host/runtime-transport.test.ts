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
  vi.spyOn(_internals, "connectS2s").mockResolvedValue(handle);
  const agent = makeAgent({ s2s: assemblyAIS2s(), ...agentOverrides });
  const build = createTransportFactory({
    agent,
    agentConfig: agent as never,
    toolSchemas: [],
    executeTool: vi.fn(),
    env: { ASSEMBLYAI_API_KEY: "k" },
    s2sConfig: DEFAULT_S2S_CONFIG,
    pipelineProviders: () => null,
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

  // The descriptor took NO options until 2026-08-09, so voice/languages/keyterms
  // were unreachable in S2S while the pipeline had all three. These ride on
  // `s2s.options` rather than on top-level config fields, so the read is a
  // separate path from `sttPrompt` above and needs its own pin.
  test("forwards the descriptor's voice/languages/keyterms", async () => {
    const handle = await buildS2sSessionConfig({
      s2s: assemblyAIS2s({
        voice: "michael",
        languages: ["en"],
        keyterms: ["Acme Rewards"],
      }),
    });
    expect(handle.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: "michael",
        languages: ["en"],
        keyterms: ["Acme Rewards"],
      }),
    );
  });

  test("omits each descriptor option the author did not set", async () => {
    const handle = await buildS2sSessionConfig({ s2s: assemblyAIS2s({ voice: "michael" }) });
    const sent = handle.updateSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toHaveProperty("voice", "michael");
    // An unset `languages` means "detect per turn" service-side — forwarding a
    // default would silently disable multilingual transcription for every agent.
    expect(sent).not.toHaveProperty("languages");
    expect(sent).not.toHaveProperty("keyterms");
  });

  test("drops a malformed descriptor option rather than putting it on the wire", async () => {
    // Descriptor options are `Record<string, unknown>` at the wire boundary, so
    // a stored config can carry anything. A non-string voice must read as
    // "unset" (service default) rather than becoming a rejected session.update
    // on a session that otherwise looks healthy.
    const handle = await buildS2sSessionConfig({
      s2s: {
        kind: "assemblyai",
        options: { voice: 42, languages: ["en", 7], keyterms: ["Acme Rewards"] },
      },
    });
    const sent = handle.updateSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("voice");
    // A mixed-type array is rejected WHOLE — forwarding the string entries
    // would silently narrow the author's declared language set.
    expect(sent).not.toHaveProperty("languages");
    // The valid sibling still goes through, so this test cannot pass merely
    // because nothing was forwarded at all.
    expect(sent).toHaveProperty("keyterms", ["Acme Rewards"]);
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
      pipelineProviders: () => ({
        stt: { opener: { name: "s", open: vi.fn() }, apiKey: "k" },
        tts: { opener: { name: "t", open: vi.fn() }, apiKey: "k" },
        llm: {} as never,
      }),
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

  test("a pipelineProviders thunk that throws reports ITS error, not 'no transport'", () => {
    // Why the dep is a thunk at all: `createRuntime` defers this resolution for
    // a `page: "static"` agent, whose injected default providers must not be
    // dialled — and a static agent given a voice surface by an embedder
    // (`createServer({ telephony: true })`) then resolves here. Passing a plain
    // `null` for that case would answer "no transport for session" and bury the
    // real cause.
    const factory = createTransportFactory({
      agent: makeAgent({ page: "static" }),
      agentConfig: {} as never,
      toolSchemas: [],
      executeTool: vi.fn(),
      env: {},
      s2sConfig: DEFAULT_S2S_CONFIG,
      pipelineProviders: () => {
        throw new Error(
          "AssemblyAI LLM: missing API key. Set ASSEMBLYAI_API_KEY in the agent env.",
        );
      },
      logger: silentLogger,
    } as never);
    expect(() =>
      factory({
        sessionOpts: {
          id: "s1",
          agent: "a",
          client: { send: vi.fn(), sendAudio: vi.fn() } as never,
        },
        systemPrompt: "sp",
        callbacks: {} as TransportCallbacks,
      }),
    ).toThrow(/missing API key/);
  });

  test("is not called at construction — only when a transport is built", () => {
    // The deferral is the whole point: a workflow app builds a runtime, serves
    // its HTTP API, and never resolves a provider credential.
    const pipelineProviders = vi.fn(() => null);
    createTransportFactory({
      agent: makeAgent({ page: "static" }),
      agentConfig: {} as never,
      toolSchemas: [],
      executeTool: vi.fn(),
      env: {},
      s2sConfig: DEFAULT_S2S_CONFIG,
      pipelineProviders,
      logger: silentLogger,
    } as never);
    expect(pipelineProviders).not.toHaveBeenCalled();
  });
});
