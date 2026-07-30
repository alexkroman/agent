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
import { startDevServer, viteDevConfig } from "./_dev-server.ts";
import { silenced, withTempDir } from "./_test-utils.ts";

describe("viteDevConfig", () => {
  test("proxies /websocket with ws:true and /health to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without ws:true the served client's WebSocket never connects.
    expect(proxy["/websocket"]).toEqual({ target: "http://localhost:3001", ws: true });
    expect(proxy["/health"]).toBe("http://localhost:3001");
  });

  test("proxies /sync and /client-config to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without /sync a custom sync client under `aai dev` 404s its turns;
    // without /client-config the default client can't learn the transport.
    expect(proxy["/sync"]).toBe("http://localhost:3001");
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
          // Pre-connection client config: a plain agent serves the agent kind.
          const cfg = await fetch(`http://127.0.0.1:${port}/client-config`);
          expect(cfg.ok).toBe(true);
          expect(await cfg.json()).toMatchObject({
            kind: "agent",
            name: "serve-test-agent",
          });
        } finally {
          await cleanup();
        }
      }),
    );
  });

  test("serves a declared workflow kind at /client-config", { timeout: 30_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        // Descriptors are pure data, so inline objects stand in for the
        // factory calls — nothing connects until a session starts.
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default {
              name: "wf-serve-agent", systemPrompt: "hi", greeting: "Talk to me.",
              tools: {}, kind: "workflow",
              stt: { kind: "assemblyai", options: {} },
              llm: { kind: "anthropic", options: { model: "claude-haiku-4-5" } },
              tts: { kind: "none", options: {} },
            };`,
        );
        await writeFile(
          path.join(dir, ".env"),
          "ASSEMBLYAI_API_KEY=test-key\nANTHROPIC_API_KEY=test-key\n",
        );

        const port = await getPort();
        const cleanup = await startDevServer({ cwd: dir, port });
        try {
          const res = await fetch(`http://127.0.0.1:${port}/client-config`);
          expect(res.ok).toBe(true);
          expect(await res.json()).toEqual({
            kind: "workflow",
            name: "wf-serve-agent",
            greeting: "Talk to me.",
          });
        } finally {
          await cleanup();
        }
      }),
    );
  });
});
