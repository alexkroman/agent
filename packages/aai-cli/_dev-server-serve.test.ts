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
import getPort from "get-port";
import { describe, expect, test } from "vitest";
import { agentEnvWarnings, startDevServer, viteDevConfig } from "./_dev-server.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";

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
