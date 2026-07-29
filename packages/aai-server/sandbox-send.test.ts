// Copyright 2026 the AAI authors. MIT license.
/**
 * A deployed agent's `send:` channel, end to end through `createSandbox`.
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

import { slack } from "@alexkroman1/aai/send";
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

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      const runtime = orig.createRuntime(opts);
      capturedRuntime.current = runtime;
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

  describe("guest side: egress for openSender", () => {
    function allowedHosts(): string[] {
      const call = mockCreateSandboxVm.mock.calls[0]?.[0] as { allowedHosts: string[] } | undefined;
      if (!call) throw new Error("createSandboxVm not called");
      return call.allowedHosts;
    }

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
