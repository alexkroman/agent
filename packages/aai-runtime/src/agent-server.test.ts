// Copyright 2026 the AAI authors. MIT license.
/**
 * `createAgentServer` — the one-call front door over createRuntime +
 * createRuntimeServer.
 *
 * The case worth pinning is `/client-config`: the two-call form made callers
 * re-state `name` and `greeting` from the agent, and omitting `greeting`
 * failed SILENTLY — the endpoint served none and the browser rendered none.
 * Reading them off the agent is the whole point, so it is asserted over the
 * wire rather than on the options object.
 *
 * The forwarding tests below are the same class of bug one layer out: an
 * option this door does not carry is one nobody can reach, because the escape
 * hatch — dropping to `createRuntime` + `createRuntimeServer` — means restating every
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
import type { Logger } from "./runtime-config.ts";

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

  test("a voice agent that declares no carrier serves no /phone", async () => {
    // The default, and the whole change: this agent is an ordinary voice agent
    // with a full pipeline, and it still answers no carrier. `telephony` used
    // to default ON here, so every server built through this door mounted the
    // route whether or not the agent had a phone number.
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      expect((await phoneRefusal(baseUrl)).message).toContain("404");
    });
  });

  test("the agent's own declaration is what mounts it", async () => {
    const myAgent = agent({
      name: "Support",
      systemPrompt: "You are helpful.",
      telephony: ["twilio"],
    });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      // Mounted: a bare `/phone` resolves to Twilio, which this agent declares,
      // so the refusal is no longer the route's — see `phoneRefusalMessage`.
      const url = `${baseUrl.replace("http", "ws")}/phone?carrier=telnyx`;
      const undeclared = await new Promise<Error>((resolve) =>
        new NodeWebSocket(url).once("error", resolve),
      );
      // Twilio is declared and Telnyx is not, on one server: the list is the
      // statement, not the boolean.
      expect(undeclared.message).toContain("404");
    });
  });

  test("an explicit telephony option overrides the agent's declaration", async () => {
    // The direction that matters for an operator: one deployment of an agent
    // that does declare a carrier, with the surface taken off.
    const myAgent = agent({
      name: "Support",
      systemPrompt: "You are helpful.",
      telephony: true,
    });

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
      // And a static agent has no pipeline to put on a call. It could not
      // declare one either — `telephony` is a compile error on `workflowApp()`
      // — so the route is absent by construction rather than switched off.
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

  test("HEAD /health answers, which is the verb a load-balancer check sends", async () => {
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      // 404 before this: the route table declares GET alone, so HEAD fell all
      // the way through the dispatch — on the one route an operator points a
      // probe at, refusing the verb HAProxy's `option httpchk` and several ALB
      // and nginx checks send by default.
      const head = await fetch(`${baseUrl}/health`, { method: "HEAD" });
      expect(head.status).toBe(200);
      // The headers a GET would send (RFC 9110) and no body — Node drops a HEAD
      // response's body itself, which is why nothing here serializes one.
      expect(head.headers.get("content-type")).toBe("application/json");
      expect(await head.text()).toBe("");
      // And the verb that already worked still does.
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    });
  });

  test("and HEAD claims nothing else — a miss is still a miss", async () => {
    // The handler goes in front of the embedder hook, so an over-broad match
    // would silently swallow somebody else's route rather than fail visibly.
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent }, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/health/deep`, { method: "HEAD" })).status).toBe(404);
      expect((await fetch(`${baseUrl}/nope`, { method: "HEAD" })).status).toBe(404);
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

/**
 * The `Serving` boot line, and the probes that keep it HONEST.
 *
 * The line exists because the WebSocket paths were documented nowhere — the
 * operator who reported this found `/websocket` and `/phone` by grepping the
 * minified client bundle. A boot line that merely LOOKS right is the same
 * problem one layer along, and this door re-derives `telephony`'s default to
 * produce it (see `servedRoutes`), so each case asserts the line against what
 * the port really answers rather than against a second copy of the expectation.
 *
 * What is probed is everything that costs no SESSION: a voice `/websocket`
 * would dial a real provider, which is this file's tier boundary, so its
 * presence on the line is asserted here and its behaviour in
 * `agent-server.scenario.test.ts`. The static case is probed in full — that
 * upgrade is declined rather than served.
 */
describe("the boot line names what this door mounts", () => {
  /** Values off one `Serving` line, with nothing narrowed by a cast. */
  function servingCapture(): {
    logger: Logger;
    http: () => string[];
    ws: () => string[];
  } {
    let line: Record<string, unknown> | undefined;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];
    return {
      logger: {
        ...silentLogger,
        info: (message: string, context?: Record<string, unknown>) => {
          if (message === "Serving") line = context;
        },
      },
      http: () => strings(line?.http),
      ws: () => strings(line?.ws),
    };
  }

  /**
   * What `/phone` answers for a carrier that does not exist: `400` when the
   * route is mounted (the route itself refuses the name), `404` when it is not.
   * The two statuses are what make this a probe of MOUNTING rather than of
   * carrier parsing.
   *
   * The carrier is named deliberately. `carrierByName` treats an ABSENT one as
   * Twilio, so a bare `/phone` against a mounted route completes the upgrade
   * and starts a real session — which dials a real provider and is this file's
   * tier boundary. Measured: the bare form hangs the spec out to its timeout
   * behind three streaming connect retries.
   */
  function phoneRefusalMessage(baseUrl: string): Promise<string> {
    const url = `${baseUrl.replace("http", "ws")}/phone?carrier=no-such-carrier`;
    return new Promise<string>((resolve) =>
      new NodeWebSocket(url).once("error", (err: Error) => resolve(err.message)),
    );
  }

  test("a voice agent: health answers both verbs, and /phone is mounted", async () => {
    const capture = servingCapture();
    const myAgent = agent({
      name: "Support",
      systemPrompt: "You are helpful.",
      // Declared, because the route is not mounted otherwise — which is what
      // the spec below this one asserts from the other side.
      telephony: true,
    });

    await withServer({ agent: myAgent, logger: capture.logger }, async (baseUrl) => {
      expect(capture.http()).toEqual([
        "GET,HEAD /health",
        "GET /client-config",
        "GET /",
        // No workflow is declared, so `/workflows/*` is not advertised.
      ]);
      // One line per DECLARED carrier: the line names the doors this deployment
      // has, so a Twilio-only agent may not advertise a `<name>` placeholder
      // covering a carrier it would refuse.
      expect(capture.ws()).toEqual([
        "/websocket",
        "/phone?carrier=twilio",
        "/phone?carrier=telnyx",
      ]);

      // Every HTTP route the line names, answered.
      expect((await fetch(`${baseUrl}/health`, { method: "HEAD" })).status).toBe(200);
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/client-config`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/`)).status).toBe(200);
      // And the one it does not: with no declared workflow the API 404s, which
      // is why listing it would advertise a surface this agent does not have.
      expect((await fetch(`${baseUrl}/workflows`)).status).toBe(404);
      // Mounted — an unknown carrier is refused by the route rather than by the
      // 404 an unmounted one gives.
      expect(await phoneRefusalMessage(baseUrl)).toContain("400");
    });
  });

  test("a workflow app: no voice routes on the line, and none on the port", async () => {
    const capture = servingCapture();
    const app = workflowApp({ name: "Digest", workflows: {} });

    await withServer({ agent: app, logger: capture.logger }, async (baseUrl) => {
      expect(capture.ws()).toEqual([]);
      expect(await phoneRefusalMessage(baseUrl)).toContain("404");
      // `/websocket` is COMPLETED and then declined with a reason rather than
      // 404'd, so the absence has to be read off the decline.
      const declined = await withDeadline(
        new Promise<string>((resolve) => {
          const ws = new NodeWebSocket(`${baseUrl.replace("http", "ws")}/websocket`);
          ws.once("message", (data: Buffer) => resolve(data.toString()));
          ws.once("close", () => resolve("closed"));
        }),
        "the static agent's /websocket upgrade was never answered",
      );
      expect(declined).toContain("static page");
    });
  });

  test("an undeclared agent has /phone on neither the line nor the port", async () => {
    // The pair the line exists to keep together: the declaration is resolved
    // here and forwarded, so the log cannot report a route the mount does not
    // make. This is now the DEFAULT case rather than an opt-out.
    const capture = servingCapture();
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer({ agent: myAgent, logger: capture.logger }, async (baseUrl) => {
      expect(capture.ws()).toEqual(["/websocket"]);
      expect(await phoneRefusalMessage(baseUrl)).toContain("404");
    });
  });

  test("a carrier list puts exactly that carrier on the line", async () => {
    const capture = servingCapture();
    const myAgent = agent({
      name: "Support",
      systemPrompt: "You are helpful.",
      telephony: ["telnyx"],
    });

    await withServer({ agent: myAgent, logger: capture.logger }, async (baseUrl) => {
      expect(capture.ws()).toEqual(["/websocket", "/phone?carrier=telnyx"]);
      // Mounted, so an unparseable carrier is the route's 400 rather than the
      // 404 an unmounted route gives — the two statuses are what make this a
      // probe of MOUNTING (see `phoneRefusalMessage`).
      expect(await phoneRefusalMessage(baseUrl)).toContain("400");
    });
  });

  test("a declared workflow puts /workflows on the line, and it answers", async () => {
    const capture = servingCapture();
    const app = workflowApp({
      name: "Digest",
      workflows: {
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

    await withServer({ agent: app, logger: capture.logger }, async (baseUrl) => {
      expect(capture.http()).toContain("/workflows/*");
      const listed = await fetch(`${baseUrl}/workflows`);
      expect(listed.status).toBe(200);
      await listed.text();
    });
  });

  test("a clientDir says so, because an operator reads / differently then", async () => {
    const capture = servingCapture();
    const myAgent = agent({ name: "Support", systemPrompt: "You are helpful." });

    await withServer(
      // The directory need not exist for the CLAIM to be right: what changes is
      // that `/` is this project's own build rather than the placeholder shell.
      { agent: myAgent, clientDir: "/nonexistent-client-dir", logger: capture.logger },
      async () => {
        expect(capture.http()).toContain("GET / (static assets)");
      },
    );
  });
});
