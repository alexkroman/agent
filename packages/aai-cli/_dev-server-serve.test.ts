// Copyright 2025 the AAI authors. MIT license.
/**
 * Serving-path tests for the dev server, deliberately mock-free: the
 * existing _dev-server tests mock createServer/createRuntime/vite wholesale,
 * so nothing there would catch the real server failing to boot or serve.
 * (The heavier Vite/client path is exercised by e2e; the proxy wiring it
 * depends on is asserted below via `viteDevConfig`.)
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/runtime";
import getPort from "get-port";
import { describe, expect, test } from "vitest";
import { agentEnvWarnings, startDevServer, viteDevConfig } from "./_dev-server.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import { DEDUPED_PEERS } from "./_vite-env.ts";

describe("agentEnvWarnings", () => {
  const DEFAULT_AGENT = {}; // no descriptors → default AssemblyAI pipeline → needs ASSEMBLYAI_API_KEY

  test("warns when a provider key is missing everywhere", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Missing provider credential");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
  });

  test("warns about the deploy cliff when a key resolves from the shell only", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, { ASSEMBLYAI_API_KEY: "sk-shell" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved from your shell, not .env");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
    expect(warnings[0]).toContain("aai publish");
  });

  test("silent when the key is declared in .env", () => {
    expect(agentEnvWarnings(DEFAULT_AGENT, { ASSEMBLYAI_API_KEY: "sk-env" }, {})).toEqual([]);
  });

  test("a requiredEnv key is flagged even when the shell exports it", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const warnings = agentEnvWarnings(
      agent,
      { ASSEMBLYAI_API_KEY: "sk-env" },
      { STRIPE_KEY: "sk-shell" }, // custom keys never fall back to the shell
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("requiredEnv");
    expect(warnings[0]).toContain("STRIPE_KEY");
  });

  test("a requiredEnv key present in .env is silent", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const env = { ASSEMBLYAI_API_KEY: "sk-env", STRIPE_KEY: "sk-env" };
    expect(agentEnvWarnings(agent, env, {})).toEqual([]);
  });
});

describe("viteDevConfig", () => {
  test("proxies /websocket with ws:true and /health to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without ws:true the served client's WebSocket never connects.
    expect(proxy["/websocket"]).toEqual({ target: "http://localhost:3001", ws: true });
    expect(proxy["/health"]).toBe("http://localhost:3001");
  });

  test("proxies /client-config to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without /client-config the default client can't learn the agent name.
    expect(proxy["/client-config"]).toBe("http://localhost:3001");
  });

  test("proxies the workflow API, the whole front door of a static app", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // A `page: "static"` agent has no socket: `page()` renders a form and every
    // call it makes is a same-origin fetch under this prefix. Unproxied, Vite
    // answers its own 404 and submitting the form fails with `Workflow API 404`
    // while the backend serves the API correctly one port over.
    expect(proxy["/workflows"]).toBe("http://localhost:3001");
  });

  test("the workflow proxy key is the prefix the API is actually served under", () => {
    // Asserted against the SDK's own constant rather than restating "/workflows"
    // — a rename there would otherwise leave a proxy entry pointing at a path
    // nothing answers, which is the same silent failure by a new route.
    const proxy = viteDevConfig("/proj", 3000, 3001).server?.proxy as Record<string, unknown>;
    expect(Object.keys(proxy)).toContain(WORKFLOW_API_PREFIX);
  });

  test("dedupes React, so a linked SDK does not render a blank page", () => {
    // aai-ui declares React as a peer; a project whose SDK is linked rather
    // than installed otherwise resolves aai-ui's own copy, and two Reacts turn
    // every hook in the page into "Invalid hook call" with a blank render.
    // `buildClient` has always deduped — this is the dev half of the same rule.
    expect(viteDevConfig("/proj", 3000, 3001).resolve?.dedupe).toEqual(DEDUPED_PEERS);
  });

  test("uses strictPort so the printed URL is never wrong", () => {
    // Vite would otherwise silently bind port+N when the port is busy while
    // executeDev prints/returns http://localhost:<requested port>.
    expect(viteDevConfig("/proj", 3000, 3001).server?.strictPort).toBe(true);
  });
});

describe("startDevServer (real serving path)", () => {
  test("boots a real agent dir and answers /health", { timeout: 30_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "serve-test-agent", systemPrompt: "hi", tools: {} };`,
        );
        // A real key value is not needed — nothing connects until a session
        // starts — but its presence keeps resolveAgentEnv from prompting.
        await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=test-key\n");

        const port = await getPort();
        const cleanup = await startDevServer({ cwd: dir, port });
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          expect(res.ok).toBe(true);
          // Pre-connection client config: the agent's display name.
          const cfg = await fetch(`http://127.0.0.1:${port}/client-config`);
          expect(cfg.ok).toBe(true);
          expect(await cfg.json()).toMatchObject({
            name: "serve-test-agent",
          });
        } finally {
          await cleanup();
        }
      }),
    );
  });
});
