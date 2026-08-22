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
 *
 * The forwarding tests below are the same class of bug one layer out: an
 * option this door does not carry is one nobody can reach, because the escape
 * hatch — dropping to `createRuntime` + `createServer` — means restating every
 * field this function derives. `telephony` and `page` were both unreachable,
 * and both are asserted over the wire for the same reason `greeting` is: what
 * failed was a value not arriving, which an options-object assertion cannot
 * see.
 */

import { agent, workflowApp } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { silentLogger, withDeadline } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";

const ENV = { ASSEMBLYAI_API_KEY: "sk-test" };

async function withServer(
  options: Omit<Parameters<typeof createAgentServer>[0], "env"> & { env?: typeof ENV },
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
      // Deadlined: a server that accepts the upgrade and then sends nothing
      // satisfies none of these three listeners, and without one the whole
      // file times out at 5 s naming no assertion.
      const first = await withDeadline(
        new Promise<Record<string, unknown>>((resolve) => {
          ws.addEventListener("message", (e: MessageEvent) => {
            if (typeof e.data === "string") resolve(JSON.parse(e.data) as Record<string, unknown>);
          });
          ws.addEventListener("close", () => resolve({ type: "closed" }));
          ws.addEventListener("error", () => resolve({ type: "error" }));
        }),
        "the session websocket neither answered nor closed",
      );
      // The handshake frame — a declining facade would have sent a
      // protocol error and closed instead.
      expect(first).toMatchObject({ type: "session.configured" });
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
        await withDeadline(
          new Promise<void>((resolve) => {
            ws.addEventListener("close", () => resolve());
            ws.addEventListener("error", () => resolve());
          }),
          "the destroyed upgrade left the socket open",
        );
        expect(sawUpgrade).toBe(true);
      },
    );
  });

  /** The status line a refused `/phone` upgrade ends the socket with. */
  function phoneRefusal(baseUrl: string): Promise<Error> {
    return new Promise<Error>((resolve) =>
      new NodeWebSocket(`${baseUrl.replace("http", "ws")}/phone`).once("error", resolve),
    );
  }

  test("telephony: false removes /phone, which nothing here could reach before", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent, telephony: false }, async (baseUrl) => {
      expect((await phoneRefusal(baseUrl)).message).toContain("404");
    });
  });

  test("a voice agent still mounts /phone by default", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      const socket = new NodeWebSocket(`${baseUrl.replace("http", "ws")}/phone`);
      await withDeadline(
        new Promise<void>((resolve) => socket.once("open", () => resolve())),
        "the default /phone route did not accept a carrier socket",
      );
      socket.close();
    });
  });

  test("page comes off the agent, and takes telephony with it", async () => {
    const app = workflowApp({ name: "Digest", workflows: {} });

    await withServer({ agent: app }, async (baseUrl) => {
      // Declared once, on the agent — the browser has to learn it before it
      // decides whether to open a mic.
      expect(await (await fetch(`${baseUrl}/client-config`)).json()).toMatchObject({
        name: "Digest",
        page: "static",
      });
      // And a static agent has no pipeline to put on a call, so the carrier
      // route follows the declaration rather than being switched off by hand.
      expect((await phoneRefusal(baseUrl)).message).toContain("404");
    });
  });

  test("an explicit page overrides the agent's own", async () => {
    const app = workflowApp({ name: "Digest", workflows: {} });

    await withServer({ agent: app, page: "voice" }, async (baseUrl) => {
      const config = (await (await fetch(`${baseUrl}/client-config`)).json()) as {
        page?: string;
      };
      // Absent, not `"voice"`: a server that never heard of the field answers
      // the same way, which is what makes absence readable as voice.
      expect(config.page).toBeUndefined();
    });
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
