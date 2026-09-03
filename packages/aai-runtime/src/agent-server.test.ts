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
 *
 * **Everything here speaks HTTP to a loopback port and nothing opens a
 * SESSION**, which is what keeps the file unit-tier. The two specs that do open
 * one are `agent-server.scenario.test.ts`: a live session dials a real provider,
 * and that is the tier boundary rather than a slow test.
 */

import { agent, workflow, workflowApp } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { z } from "zod";
import { AGENT_SERVER_ENV as ENV, withServer } from "./_agent-server-test-utils.ts";
import { silentLogger, withDeadline } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";

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
      // Stated, not absent: the override is what decides the front door, and a
      // reader should not have to infer it from a missing key.
      expect(config.page).toBe("voice");
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

describe("the env this door forwards to the server", () => {
  const workflowAgent = () =>
    workflowApp({
      name: "Digest",
      workflows: {
        // A declared workflow is what makes `/workflows/*` answer at all: with none,
        // every route 404s naming the reason and an auth test could not tell a closed
        // surface from an absent one. The body is never run here — nothing starts a
        // run — so it needs no DevKit build.
        echo: workflow({
          description: "Echo the input back.",
          input: z.object({ text: z.string() }),
          run: async ({ text }) => {
            "use workflow";
            return text;
          },
        }),
      },
    });

  test("AAI_WORKFLOW_API_TOKEN closes the workflow API, as it is documented to", async () => {
    await withServer(
      { agent: workflowAgent(), env: { ...ENV, AAI_WORKFLOW_API_TOKEN: "s3cret" } },
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/workflows`)).status).toBe(401);
        expect(
          (await fetch(`${baseUrl}/workflows`, { headers: { authorization: "Bearer wrong" } }))
            .status,
        ).toBe(401);
        const ok = await fetch(`${baseUrl}/workflows`, {
          headers: { authorization: "Bearer s3cret" },
        });
        expect(ok.status).toBe(200);
        await ok.text();
      },
    );
  });

  test("and closes the upload WRITE routes with it", async () => {
    // The cost shape the workflow API's own doc argues about: an unauthenticated
    // POST here does not just read, it stores bytes.
    await withServer(
      { agent: workflowAgent(), env: { ...ENV, AAI_WORKFLOW_API_TOKEN: "s3cret" } },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/workflows/uploads`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "bytes",
        });
        expect(res.status).toBe(401);
        await res.text();
      },
    );
  });

  test("AAI_SESSION_EVENTS_TOKEN closes the event-stream read surface", async () => {
    await withServer(
      { agent: workflowAgent(), env: { ...ENV, AAI_SESSION_EVENTS_TOKEN: "e3vents" } },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/session-events/any-session`);
        expect(res.status).toBe(401);
        await res.text();
      },
    );
  });

  test("an env with no tokens leaves the documented fail-OPEN posture alone", async () => {
    // Fail-open is the default on purpose — a static page carries no credential —
    // so forwarding the env must not close a surface nobody asked to close.
    await withServer({ agent: workflowAgent() }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/workflows`);
      expect(res.status).toBe(200);
      await res.text();
    });
  });

  test("AAI_ALLOW_HOST does NOT ride along, so this door grants no host mode", async () => {
    // The one key that must not arrive with the others: `?host=1` lets a caller
    // replace the agent definition and run it on this server's credentials. The
    // session is declined and the socket closed rather than handed a host session.
    await withServer(
      {
        agent: agent({ name: "Support", systemPrompt: "x" }),
        env: { ...ENV, AAI_ALLOW_HOST: "1" },
      },
      async (baseUrl) => {
        const ws = new NodeWebSocket(`${baseUrl.replace("http", "ws")}/websocket?host=1`);
        const refusal = await withDeadline(
          new Promise<string>((resolve, reject) => {
            ws.once("message", (data: Buffer) => resolve(data.toString()));
            ws.once("close", () => resolve("closed"));
            ws.once("error", (err: Error) => reject(err));
          }),
          "a ?host=1 connection is answered",
        );
        ws.close();
        // The server's own refusal, which is what `isHostAllowed` answering false
        // looks like on the wire — not a host session waiting for a config frame.
        expect(refusal).toContain("host mode is not enabled on this server");
      },
    );
  });
});
