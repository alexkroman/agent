import deployedDef from "virtual:aai/agent";
import {
  hashCode,
  type RouteHandler,
  type RouteRequest,
  verifyStandardWebhook,
} from "@alexkroman1/aai";
import type { ClientTranscript } from "@alexkroman1/aai/step";
import {
  createRouteContext,
  createRunSnapshot,
  createToolContext,
  createWorkflowContext,
  expectDeployable,
  runWorkflow,
  stubClientTranscript,
} from "@alexkroman1/aai-runtime/testing";
import {
  describeAgent,
  installStubClientInbox,
  installStubWorkflows,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { MAX_LINK_ATTEMPTS, PAIR_CODE_DIGITS } from "./shared.ts";
import leaveMessage from "./tools/leave_message.ts";
import linkPhone from "./tools/link_phone.ts";
import announce, { announceFlow } from "./workflows/announce.ts";
import digest, { digestOf } from "./workflows/digest.ts";
import pair from "./workflows/pair.ts";

const SECRET = "whsec_dGVzdC1kb29yYmVsbC1zZWNyZXQ=";

/** One of the agent's route handlers, by its key. */
function handler(key: string): RouteHandler {
  const found = deployedDef.routes?.[key];
  if (typeof found !== "function") throw new Error(`no route ${key}`);
  return found;
}

function request(over: Partial<RouteRequest>): RouteRequest {
  return { method: "GET", path: "/", params: {}, query: {}, headers: {}, body: undefined, ...over };
}

/** What a thrown routeError carries, without naming its class. */
async function refusal(promise: unknown): Promise<{ status: number }> {
  try {
    await promise;
  } catch (err: unknown) {
    return err as { status: number };
  }
  throw new Error("expected the route to refuse");
}

/**
 * A Standard Webhooks delivery of `body`, signed the way doorbell hardware would: an
 * HMAC-SHA256 of `id.timestamp.rawBody` under the secret's decoded key. Web Crypto only,
 * as the SDK's own check is.
 */
async function signedRing(body: unknown, secret = SECRET): Promise<RouteRequest> {
  const rawBody = JSON.stringify(body);
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const keyBytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
    ),
  );
  const signature = btoa(String.fromCharCode(...mac));
  return request({
    method: "POST",
    path: "/ring",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
    rawBody,
  });
}

describeAgent(deployedDef, (run) => {
  describe("the agent", () => {
    test("deploys with its tools, routes and workflows", () => {
      expect(expectDeployable(deployedDef).name).toBe("Front Door");
      expect(Object.keys(deployedDef.tools ?? {}).sort()).toEqual(["leave_message", "link_phone"]);
      expect(Object.keys(deployedDef.routes ?? {}).sort()).toEqual([
        "GET /pair/:runId",
        "POST /digest",
        "POST /pair",
        "POST /ring",
      ]);
      expect(Object.keys(deployedDef.workflows ?? {}).sort()).toEqual([
        "announce",
        "digest",
        "pair",
      ]);
    });
  });

  describe("linking a phone", () => {
    test("POST /pair shows a code once and keys the waiting run by its hash, never the code", async () => {
      const workflows = installStubWorkflows({ agent: deployedDef, runId: "wrun_pair" });
      const ctx = createRouteContext({ workflows });
      const started = (await handler("POST /pair")(
        request({ method: "POST", path: "/pair", clientId: "phone-1" }),
        ctx,
      )) as { runId: string; code: string };
      expect(started.runId).toBe("wrun_pair");
      expect(started.code).toMatch(new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`));
      expect(workflows.start).toHaveBeenCalledWith(
        pair,
        { phoneId: "phone-1" },
        { key: await hashCode(started.code), label: "Linking a phone" },
      );
    });

    test("GET /pair/:runId says waiting, then the door's id, but only to the phone that asked", async () => {
      const get = handler("GET /pair/:runId");
      const ask = (clientId: string) =>
        request({ path: "/pair/wrun_pair", params: { runId: "wrun_pair" }, clientId });
      const waiting = installStubWorkflows({
        agent: deployedDef,
        runs: [createRunSnapshot(pair, { runId: "wrun_pair", status: "running" })],
      });
      expect(await get(ask("phone-1"), createRouteContext({ workflows: waiting }))).toEqual({
        status: "waiting",
      });

      const done = createRouteContext({
        workflows: installStubWorkflows({
          agent: deployedDef,
          runs: [
            createRunSnapshot(pair, {
              runId: "wrun_pair",
              status: "completed",
              output: { linked: true, phoneId: "phone-1", doorId: "door-1" },
            }),
          ],
        }),
      });
      expect(await get(ask("phone-1"), done)).toEqual({ status: "linked", doorId: "door-1" });
      expect(await refusal(get(ask("someone-else"), done))).toMatchObject({ status: 404 });
    });

    test("an unanswered code reads as expired", async () => {
      const ctx = createRouteContext({
        workflows: installStubWorkflows({
          agent: deployedDef,
          runs: [
            createRunSnapshot(pair, {
              status: "completed",
              output: { linked: false, phoneId: "phone-1" },
            }),
          ],
        }),
      });
      const answer = await handler("GET /pair/:runId")(
        request({ params: { runId: "r" }, clientId: "phone-1" }),
        ctx,
      );
      expect(answer).toEqual({ status: "expired" });
    });

    /** A workflow client with one phone waiting, under the hash of `code`. */
    async function waitingUnder(code: string) {
      const hash = await hashCode(code);
      const waiting = createRunSnapshot(pair, { runId: "wrun_pair", key: hash, status: "running" });
      const workflows = installStubWorkflows({ agent: deployedDef });
      return {
        hash,
        workflows: {
          ...workflows,
          live: vi.fn(async (_def: unknown, key?: string) => (key === hash ? waiting : undefined)),
        },
      };
    }

    test("link_phone hears the code however it was spoken and signals the waiting phone", async () => {
      const { hash, workflows } = await waitingUnder("481902");
      const ctx = createToolContext({ clientId: "door-1", workflows });
      expect(await run(linkPhone, { code: "4819-02" }, ctx)).toEqual({ linked: true });
      expect(workflows.signalRun).toHaveBeenCalledWith(pair, hash, "linked", { doorId: "door-1" });
    });

    test("a wrong code is refused and counted, and the cap stops the guessing", async () => {
      const { workflows } = await waitingUnder("481902");
      const ctx = createToolContext({ clientId: "door-1", workflows });
      for (let i = 0; i < MAX_LINK_ATTEMPTS; i++) {
        expect(await run(linkPhone, { code: `00000${i}` }, ctx)).toHaveProperty("error");
      }
      // Even the right code is refused now, without a lookup.
      workflows.live.mockClear();
      expect(await run(linkPhone, { code: "481902" }, ctx)).toHaveProperty("error");
      expect(workflows.live).not.toHaveBeenCalled();
      expect(workflows.signalRun).not.toHaveBeenCalled();
    });

    test("a session with no ?client= has no door to link to", async () => {
      const ctx = createToolContext({ workflows: installStubWorkflows({ agent: deployedDef }) });
      expect(await run(linkPhone, { code: "481902" }, ctx)).toHaveProperty("error");
    });
  });

  describe("telling the phone", () => {
    test("leave_message hands the visitor's message to a run keyed by the door", async () => {
      const workflows = installStubWorkflows({ agent: deployedDef });
      const ctx = createToolContext({ clientId: "door-1", workflows });
      expect(
        await run(leaveMessage, { name: "Sam", message: "Parcel is behind the bin" }, ctx),
      ).toEqual({
        passed_on: true,
      });
      expect(workflows.start).toHaveBeenCalledWith(
        announce,
        {
          doorId: "door-1",
          notice: { kind: "visitor", name: "Sam", message: "Parcel is behind the bin" },
        },
        { key: "door-1", label: "Message from Sam" },
      );
    });

    test("POST /ring takes only a delivery signed with the doorbell's secret", async () => {
      const workflows = installStubWorkflows({ agent: deployedDef });
      const ctx = createRouteContext({ env: { DOORBELL_WEBHOOK_SECRET: SECRET }, workflows });
      const ring = handler("POST /ring");

      const delivery = await signedRing({ door: "door-1" });
      // The spec's signer is the one the SDK's own check accepts.
      expect(await verifyStandardWebhook(delivery, SECRET)).toBe(true);
      expect(await ring(delivery, ctx)).toEqual({ runId: "wrun_stub" });
      expect(workflows.start).toHaveBeenCalledWith(
        announce,
        { doorId: "door-1", notice: { kind: "ring" } },
        { key: "door-1", label: "The bell rang" },
      );

      const forged = await signedRing({ door: "door-1" }, "whsec_b3RoZXItc2VjcmV0");
      expect(await ring(forged, ctx)).toMatchObject({ status: 401 });
      expect(await refusal(ring(await signedRing({ door: "not a door!" }), ctx))).toMatchObject({
        status: 400,
      });
      expect(workflows.start).toHaveBeenCalledTimes(1);
    });

    test("POST /digest summarizes the door the phone is linked to", async () => {
      const workflows = installStubWorkflows({ agent: deployedDef });
      const ctx = createRouteContext({ workflows });
      await handler("POST /digest")(request({ method: "POST", clientId: "door-1" }), ctx);
      expect(workflows.start).toHaveBeenCalledWith(
        digest,
        { doorId: "door-1", since: expect.any(Number) },
        { key: "door-1", label: "Today at the door" },
      );
    });
  });

  describe("digestOf", () => {
    const session = (
      said: string[],
      tools: ClientTranscript["sessions"][number]["tools"] = [],
    ) => ({
      sessionId: `s${said.length}${tools.length}`,
      startedAt: 0,
      lastEventIndex: 0,
      messages: said.map((text, i) => ({ role: i % 2 ? "user" : "assistant", text, at: i })),
      tools,
    });
    const left = (name: string, message: string) => ({
      name: "leave_message",
      args: { name, message },
      result: '{"passed_on":true}',
      at: 0,
    });

    test("counts visits and quotes every message left", () => {
      expect(
        digestOf({
          sessions: [
            session(["Hello", "Delivery"], [left("Sam", "Parcel by the bin")]),
            // The greeting alone: nobody said anything, so not a visit.
            session(["Hello"]),
            session(["Hello", "Hi it's Ana", "OK"], [left("Ana", "Call me")]),
          ],
        }),
      ).toBe('2 visits today. Messages: Sam: "Parcel by the bin"; Ana: "Call me".');
    });

    test("says so when the day was quiet", () => {
      expect(digestOf({ sessions: [] })).toBe("Nobody came to the door today.");
      expect(digestOf({ sessions: [session(["Hello", "Wrong house"])] })).toBe(
        "One visit today, and no messages.",
      );
    });
  });

  describe("the run is DURABLE", () => {
    test("pair parks on the door's signal and completes linked when it comes", async () => {
      const handle = await runWorkflow(
        deployedDef,
        "pair",
        { phoneId: "phone-1" },
        { key: "hash" },
      );
      expect(handle.status).toBe("running");
      await handle.signalRun("linked", { doorId: "door-1" });
      expect(handle.status).toBe("completed");
      expect(handle.output).toEqual({ linked: true, phoneId: "phone-1", doorId: "door-1" });
    });

    test("pair gives up when its window closes with no door", async () => {
      const handle = await runWorkflow(
        deployedDef,
        "pair",
        { phoneId: "phone-1" },
        { key: "hash" },
      );
      await handle.expireWaits();
      expect(handle.output).toEqual({ linked: false, phoneId: "phone-1" });
    });

    test("announce fails the attempt as retryable while the phone is away, so the step redelivers", async () => {
      installStubClientInbox({ answer: "offline" });
      const ctx = createWorkflowContext({ runId: "wrun_9" });
      await expect(
        announceFlow({ doorId: "door-1", notice: { kind: "ring" } }, ctx),
      ).rejects.toMatchObject({ name: "ClientUnreachableError", reason: "offline" });
    });

    test("announce delivers once under the run id, even when the worker dies mid-delivery", async () => {
      const inbox = installStubClientInbox();
      const handle = await runWorkflow(
        deployedDef,
        "announce",
        { doorId: "door-1", notice: { kind: "visitor", name: "Sam", message: "Parcel" } },
        { crashAt: "notify" },
      );
      expect(handle.crashed).toBe(true);
      await handle.restart();
      expect(handle.status).toBe("completed");
      // Every attempt carries the run id, so a repeat after a lost ack is one the phone drops.
      expect(new Set(inbox.calls.map((c) => c.notice.id))).toEqual(new Set([handle.runId]));
      expect(inbox.calls.at(-1)).toMatchObject({
        clientId: "door-1",
        notice: { event: "visitor", data: { kind: "visitor", name: "Sam", message: "Parcel" } },
      });
    });

    test("digest reads the day once, even when the worker dies before telling the phone", async () => {
      const transcript = stubClientTranscript({
        sessions: [
          {
            sessionId: "s1",
            startedAt: 0,
            lastEventIndex: 3,
            messages: [
              { role: "assistant", text: "Hello", at: 0 },
              { role: "user", text: "Delivery", at: 1 },
            ],
            tools: [],
          },
        ],
      });
      onTestFinished(transcript.restore);
      const inbox = installStubClientInbox();
      const handle = await runWorkflow(
        deployedDef,
        "digest",
        { doorId: "door-1", since: 0 },
        { crashAt: "notify" },
      );
      expect(handle.crashed).toBe(true);
      await handle.restart();
      expect(handle.status).toBe("completed");
      expect(handle.output).toEqual({ summary: "One visit today, and no messages." });
      expect(transcript.calls).toEqual([{ clientId: "door-1", options: { since: 0 } }]);
      expect(inbox.calls.map((c) => c.notice.data)).toEqual([
        { kind: "digest", summary: "One visit today, and no messages." },
      ]);
    });
  });
});
