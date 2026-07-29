// Copyright 2026 the AAI authors. MIT license.
/**
 * What a deployed agent may reach on the network, end to end through
 * `createSandbox` — the agent's declared `allowedHosts` plus its `send:`
 * channel's webhook host.
 *
 * The channel has two sides and each was dropped between the deploy config
 * and the thing that reads it:
 *
 * - **Host side** — the `send_message` builtin, which `createRuntime`
 *   registers only when `agent.send` is set. `toRuntimeAgent` did not copy
 *   `config.send`, so a deployed `send: slack()` was a silent no-op: the tool
 *   never reached the LLM's schema list, so the symptom was a reply that
 *   simply didn't send, indistinguishable from the model ignoring the prompt.
 * - **Guest side** — tool code calling `openSender` posts through the
 *   sandbox's proxied fetch, which the host validates against `allowedHosts`.
 *   Nothing derived the channel's webhook host, and `registerGuestRpcHandlers`
 *   registers no fetch handler at all for an empty list.
 *
 * Lives apart from `sandbox.test.ts` (which is near the 700-line test cap)
 * with its own mock scaffolding: these need the *returned* runtime, not the
 * `executeTool` that file captures.
 */

import { anthropic } from "@alexkroman1/aai/llm";
import { slack } from "@alexkroman1/aai/send";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createTestStorage } from "./test-utils.ts";

const { mockCreateSandboxVm } = vi.hoisted(() => {
  const mockConn: NdjsonConnection = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    mockCreateSandboxVm: vi.fn().mockResolvedValue({
      conn: mockConn,
      shutdown: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sandbox-vm.ts")>();
  return { ...orig, createSandboxVm: mockCreateSandboxVm };
});

/**
 * The runtime `createSandbox` built. `toolSchemas` on it is what the LLM is
 * actually offered, so it — not the config→agent mapping — is the assertion
 * target for builtin registration.
 */
const capturedRuntime: { current: import("@alexkroman1/aai/runtime").Runtime | null } = {
  current: null,
};

/**
 * The options `createSandbox` handed `createRuntime`. Whether the providers
 * reached it is the whole question for the pipeline specs below — by the time a
 * runtime exists the transport choice is already made and invisible.
 */
const capturedOpts: {
  current: Parameters<typeof import("@alexkroman1/aai/runtime").createRuntime>[0] | null;
} = { current: null };

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      const runtime = orig.createRuntime(opts);
      capturedRuntime.current = runtime;
      capturedOpts.current = opts;
      return runtime;
    },
  };
});

const BASE_CONFIG: IsolateConfig = {
  name: "test-agent",
  systemPrompt: "You are a test agent",
  greeting: "Hello!",
  maxSteps: 3,
  toolSchemas: [],
  builtinTools: [],
  allowedHosts: [],
};

const SEND_CONFIG: IsolateConfig = { ...BASE_CONFIG, send: slack() };

function makeSandboxOptions(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workerCode: 'export default { name: "test" };',
    env: { AAI_ENV_TEST: "1" },
    storage: createTestStorage(),
    slug: "test-agent",
    agentConfig: BASE_CONFIG,
    ...overrides,
  };
}

function toolNames(): string[] {
  const runtime = capturedRuntime.current;
  if (!runtime) throw new Error("runtime not captured");
  return runtime.toolSchemas.map((s) => s.name);
}

describe("createSandbox — send channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRuntime.current = null;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("host side: the send_message builtin", () => {
    it("is registered when the config declares a channel", async () => {
      const sandbox = createSandbox(makeSandboxOptions({ agentConfig: SEND_CONFIG }));

      expect(toolNames()).toContain("send_message");
      await sandbox.shutdown();
    });

    it("is absent when the config declares no channel", async () => {
      const sandbox = createSandbox(makeSandboxOptions());

      expect(toolNames()).not.toContain("send_message");
      await sandbox.shutdown();
    });

    it("resolves its credential from the agent env", async () => {
      const sandbox = createSandbox(makeSandboxOptions({ agentConfig: SEND_CONFIG }));
      const runtime = capturedRuntime.current;
      if (!runtime) throw new Error("runtime not captured");

      // This agent's env holds no webhook URL. Naming the missing variable
      // proves the builtin resolved against the agent env and ran, rather
      // than failing some earlier way.
      const result = await runtime.executeTool("send_message", { text: "hi" }, "s1", []);

      expect(result).toContain("SLACK_WEBHOOK_URL");
      await sandbox.shutdown();
    });
  });

  describe("guest side: egress for guest tool code", () => {
    function allowedHosts(): string[] {
      const call = mockCreateSandboxVm.mock.calls[0]?.[0] as { allowedHosts: string[] } | undefined;
      if (!call) throw new Error("createSandboxVm not called");
      return call.allowedHosts;
    }

    it("passes the agent's declared hosts through to the guest RPC layer", async () => {
      const sandbox = createSandbox(
        makeSandboxOptions({
          agentConfig: { ...BASE_CONFIG, allowedHosts: ["api.example.com", "*.example.org"] },
        }),
      );

      expect(allowedHosts()).toEqual(["api.example.com", "*.example.org"]);
      await sandbox.shutdown();
    });

    it("allowlists the channel's webhook host", async () => {
      const sandbox = createSandbox(makeSandboxOptions({ agentConfig: SEND_CONFIG }));

      expect(allowedHosts()).toEqual(["hooks.slack.com"]);
      await sandbox.shutdown();
    });

    it("unions the channel host with the config's own hosts, without duplicates", async () => {
      const sandbox = createSandbox(
        makeSandboxOptions({
          agentConfig: { ...SEND_CONFIG, allowedHosts: ["api.example.com", "hooks.slack.com"] },
        }),
      );

      expect(allowedHosts()).toEqual(["api.example.com", "hooks.slack.com"]);
      await sandbox.shutdown();
    });

    it("adds no hosts when the agent declares no channel", async () => {
      const sandbox = createSandbox(makeSandboxOptions());

      // Must stay empty: a non-empty list is what turns guest fetch on at all.
      expect(allowedHosts()).toEqual([]);
      await sandbox.shutdown();
    });
  });
});

describe("createSandbox — pipeline providers must never silently become S2S", () => {
  beforeEach(() => {
    capturedRuntime.current = null;
    capturedOpts.current = null;
    mockCreateSandboxVm.mockClear();
  });

  const PROVIDERS = {
    stt: assemblyAI({ model: "universal-3-5-pro" }),
    llm: anthropic({ model: "claude-haiku-4-5" }),
    tts: cartesia(),
  } as const;

  const PROVIDER_ENV = {
    ASSEMBLYAI_API_KEY: "k",
    ANTHROPIC_API_KEY: "k",
    CARTESIA_API_KEY: "k",
  };

  function forwardedProviders(): { stt: boolean; llm: boolean; tts: boolean } {
    const opts = capturedOpts.current;
    if (!opts) throw new Error("createRuntime opts not captured");
    return {
      stt: opts.stt !== undefined,
      llm: opts.llm !== undefined,
      tts: opts.tts !== undefined,
    };
  }

  it("forwards the providers when the config declares mode: pipeline", async () => {
    const sandbox = createSandbox(
      makeSandboxOptions({
        agentConfig: { ...BASE_CONFIG, mode: "pipeline", ...PROVIDERS },
        env: PROVIDER_ENV,
      }),
    );

    expect(forwardedProviders()).toEqual({ stt: true, llm: true, tts: true });
    await sandbox.shutdown();
  });

  it("forwards the providers when the config omits mode", async () => {
    // `mode` is optional in IsolateConfigSchema, so a config can carry all
    // three descriptors with no `mode` at all. Gating the forward on
    // `config.mode === "pipeline"` dropped every provider for such a config:
    // createRuntime then saw an agent with none, resolved S2S, and ran a fully
    // working S2S session on the agent's own key — with nothing logged to say
    // the configured STT/LLM/TTS had been ignored. The descriptors are the
    // source of truth; the schema's superRefine already rejects a `mode` that
    // disagrees with them.
    const sandbox = createSandbox(
      makeSandboxOptions({
        agentConfig: { ...BASE_CONFIG, ...PROVIDERS },
        env: PROVIDER_ENV,
      }),
    );

    expect(forwardedProviders()).toEqual({ stt: true, llm: true, tts: true });
    await sandbox.shutdown();
  });

  it("forwards nothing for a genuine S2S agent", async () => {
    // S2S stays reachable — it just has to be what the agent actually declared.
    const sandbox = createSandbox(makeSandboxOptions());

    expect(forwardedProviders()).toEqual({ stt: false, llm: false, tts: false });
    await sandbox.shutdown();
  });
});

describe("createSandbox — pipeline voice tuning", () => {
  beforeEach(() => {
    capturedRuntime.current = null;
    mockCreateSandboxVm.mockClear();
  });

  // The other half of the same drop: `toRuntimeAgent` copies the six pipeline
  // tuning fields but deliberately NOT stt/llm/tts, which `createSandbox`
  // passes to `createRuntime` as options instead. `createRuntime` validated the
  // agent object alone, so mode resolved to "s2s" and `assertPipelineTuning`
  // rejected every one of those fields — a deployed pipeline agent setting
  // `holdPhrase` failed at session start with "holdPhrase requires pipeline
  // mode (stt, llm, and tts all set)" while listing all three providers.
  const PIPELINE_CONFIG: IsolateConfig = {
    ...BASE_CONFIG,
    mode: "pipeline",
    stt: assemblyAI({ model: "universal-3-5-pro" }),
    llm: anthropic({ model: "claude-haiku-4-5" }),
    tts: cartesia(),
  };

  it("starts a deployed pipeline agent that sets holdPhrase", async () => {
    const sandbox = createSandbox(
      makeSandboxOptions({
        agentConfig: { ...PIPELINE_CONFIG, holdPhrase: "I'll look that up now." },
        env: { ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", CARTESIA_API_KEY: "k" },
      }),
    );

    expect(capturedRuntime.current).not.toBeNull();
    await sandbox.shutdown();
  });

  it("forwards holdPhrase and errorPhrase to the runtime agent", async () => {
    // Both are spoken filler, so a dropped one is silence — the failure mode
    // this whole file exists for. `errorPhrase` is the newest field through
    // `toRuntimeAgent`, which makes it the most likely to go missing.
    const sandbox = createSandbox(
      makeSandboxOptions({
        agentConfig: {
          ...PIPELINE_CONFIG,
          holdPhrase: "I'll look that up now.",
          errorPhrase: "My brain went offline.",
        },
        env: { ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", CARTESIA_API_KEY: "k" },
      }),
    );

    expect(capturedOpts.current?.agent).toMatchObject({
      holdPhrase: "I'll look that up now.",
      errorPhrase: "My brain went offline.",
    });
    await sandbox.shutdown();
  });

  it("starts a deployed pipeline agent that sets the endpointing knobs", async () => {
    const sandbox = createSandbox(
      makeSandboxOptions({
        agentConfig: {
          ...PIPELINE_CONFIG,
          minBargeInWords: 3,
          interruptionMinDurationMs: 200,
          endpointSettleMs: 900,
          completeSettleMs: 300,
          falseInterruptionTimeoutMs: 1500,
        },
        env: { ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", CARTESIA_API_KEY: "k" },
      }),
    );

    expect(capturedRuntime.current).not.toBeNull();
    await sandbox.shutdown();
  });
});
