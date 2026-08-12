// Copyright 2026 the AAI authors. MIT license.
/**
 * `createAgentServer` — the one-call front door over createRuntime +
 * createServer.
 *
 * The case worth pinning is `/client-config`: the two-call form made callers
 * re-state `name` and `greeting` from the agent, and omitting `greeting`
 * failed SILENTLY — the endpoint served none and the browser rendered none.
 * Reading them off the agent is the whole point, so it is asserted over the
 * wire rather than on the options object.
 */

import { describe, expect, test } from "vitest";
import { agent } from "../sdk/define.ts";
import { silentLogger } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";

const ENV = { ASSEMBLYAI_API_KEY: "sk-test" };

async function withServer(
  options: Omit<Parameters<typeof createAgentServer>[0], "env"> & {
    env?: Record<string, string>;
  },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createAgentServer({ env: ENV, logger: silentLogger, ...options });
  await server.listen(0);
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

describe("createAgentServer", () => {
  test("an agent env setting AAI_ALLOW_HOST does not open host mode", async () => {
    // `createServer` gates host mode on `env && isHostAllowed(env)`, and this
    // wrapper forwards `env` only for the workflow API's optional bearer — so
    // forwarding it wholesale would let an unauthenticated `?host=1` client
    // supply its own system prompt and tool schemas and run them on THIS
    // operator's credentials, for any agent whose env happens to carry the flag.
    // It passed no `env` at all before the workflow token needed one here, so
    // refusing is also the pre-existing behaviour.
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent, env: { ...ENV, AAI_ALLOW_HOST: "1" } }, async (baseUrl) => {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/websocket?host=1`);
      const closed = await new Promise<{ code: number }>((resolve) => {
        ws.addEventListener("close", (e: CloseEvent) => resolve({ code: e.code }));
        ws.addEventListener("error", () => resolve({ code: 0 }));
      });
      // Refused rather than upgraded into a host session.
      expect(closed.code).not.toBe(1000);
    });
  });

  test("serves the agent's own name and greeting without being told them", async () => {
    const myAgent = agent({
      name: "Support",
      systemPrompt: "You are helpful.",
      greeting: "Hi, how can I help?",
    });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      expect(await (await fetch(`${baseUrl}/client-config`)).json()).toMatchObject({
        name: "Support",
        greeting: "Hi, how can I help?",
      });
      expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({
        status: "ok",
        name: "Support",
      });
    });
  });

  test("a session websocket is accepted (the runtime is real, not a facade)", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/websocket`);
      const first = await new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener("message", (e: MessageEvent) => {
          if (typeof e.data === "string") resolve(JSON.parse(e.data) as Record<string, unknown>);
        });
        ws.addEventListener("close", () => resolve({ type: "closed" }));
        ws.addEventListener("error", () => resolve({ type: "error" }));
      });
      // The ready `config` frame — a declining facade would have sent a
      // protocol error and closed instead.
      expect(first).toMatchObject({ type: "config" });
      ws.close();
    });
  });

  test("the upgrade hook still gets first look", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });
    let sawUpgrade = false;

    await withServer(
      {
        agent: myAgent,
        upgrade: (_req, socket) => {
          sawUpgrade = true;
          socket.destroy();
          return true;
        },
      },
      async (baseUrl) => {
        const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/websocket`);
        await new Promise<void>((resolve) => {
          ws.addEventListener("close", () => resolve());
          ws.addEventListener("error", () => resolve());
        });
        expect(sawUpgrade).toBe(true);
      },
    );
  });

  test("close() shuts the runtime down, so callers need no second call", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });
    const server = createAgentServer({ agent: myAgent, env: ENV, logger: silentLogger });
    await server.listen(0);
    const port = server.port;
    await server.close();

    expect(server.port).toBeUndefined();
    // The port is really released — a second listen on it would fail if the
    // HTTP server were still bound.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
