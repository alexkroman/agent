// Copyright 2026 the AAI authors. MIT license.
/**
 * The two `createAgentServer` specs that open a real SESSION — and so reach a
 * real provider.
 *
 * `agent-server.test.ts` keeps the other eleven and stays unit-tier: they speak
 * HTTP to a loopback port, which the tier permits. These two do not, and the
 * difference is not the route but what it starts. Opening `/websocket` or
 * `/phone` builds a live voice session, and the runtime is REAL here (that is
 * the claim the first one makes), so the STT opener genuinely dials AssemblyAI
 * and is genuinely told `Unauthorized Connection: Invalid API key` — the env is
 * a placeholder, deliberately (`AGENT_SERVER_ENV`).
 *
 * **Real network is the unit tier's boundary**, per AGENTS.md's membership rule:
 * a tier is cut by what a test may TOUCH. So these belong here, and living in
 * the unit tier had exactly the consequence that rule exists to prevent — they
 * failed on any machine with egress to AssemblyAI while passing wherever that
 * connect fails fast, which is the green-in-CI/red-locally asymmetry running
 * backwards.
 *
 * ## What they were actually failing on, which is teardown
 *
 * Both assertions resolve promptly and inside their own 2s `withDeadline`. What
 * overran the 5s unit budget is `withServer`'s `server.close()`: it drains the
 * session, and the session is three provider connect attempts at 2.5s each. So
 * the fix is a tier with room for a real retry ladder (120s), not a longer
 * deadline on the assertion — measured at 5.3s and 6.0s, both of it teardown.
 *
 * They are NOT gated on anything. Unlike this package's other scenario suites
 * there is no database and no stack involved; the only external thing is the
 * provider's refusal, which is as reachable from a laptop as from CI.
 */

import { agent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { AGENT_SERVER_ENV, withServer } from "./_agent-server-test-utils.ts";
import { withDeadline } from "./_test-utils.ts";

describe("createAgentServer over a live session", () => {
  test("a session websocket is accepted (the runtime is real, not a facade)", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/websocket`);
      // Deadlined: a server that accepts the upgrade and then sends nothing
      // satisfies none of these three listeners, and without one the file times
      // out naming no assertion.
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
      // The handshake frame — a declining facade would have sent a protocol
      // error and closed instead. Note it arrives even though the provider
      // refuses the key: configuring the session is the runtime's own work, and
      // that is what this asserts.
      expect(first).toMatchObject({ type: "session.configured" });
      ws.close();
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
      expect(socket.readyState).toBe(NodeWebSocket.OPEN);
      socket.close();
    });
  });

  test("the placeholder key really is one, so neither spec depends on a credential", async () => {
    // The reason these two are here rather than beside their siblings, asserted
    // rather than left to the header: if `AGENT_SERVER_ENV` ever held a working
    // key the tier argument above would quietly stop being true.
    expect(AGENT_SERVER_ENV.ASSEMBLYAI_API_KEY).toBe("sk-test");
  });
});
