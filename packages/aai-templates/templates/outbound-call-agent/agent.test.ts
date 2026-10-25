// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the outbound caller, in the order a call travels:
 *
 * - **The API** — auth, validation, and that a call is one run keyed by its
 *   id, against a stubbed `ctx.workflows`.
 * - **The brief** — that a session whose parameters this app did not sign is
 *   refused before it starts, and a signed one gets its task.
 * - **The session** — `press_keys`, `end_call`, and the hand-over of the
 *   transcript to the run as the session ends.
 * - **The run, durably** — `callFlow` on the real replay engine
 *   (`runWorkflow`) against a stubbed Twilio and model: it suspends while the
 *   phone rings and while the call is talked, resumes on the session's signal
 *   without dialling twice, and turns every way a call can go into a record.
 */

import agentDef from "virtual:aai/agent";
import {
  type RouteRequest,
  readCallBrief,
  type SessionCall,
  type SessionEndContext,
  sessionCall,
  signCallBrief,
} from "@alexkroman1/aai";
import { sentDtmfCalls } from "@alexkroman1/aai/experimental";
import {
  createRouteContext,
  createRunSnapshot,
  createToolContext,
  endSessionCalls,
  type RunWorkflowOptions,
  runWorkflow,
  stubGatewayRoute,
  stubPlaceCall,
  type TestToolContext,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent, installStubWorkflows } from "@alexkroman1/aai-runtime/testing/vitest";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createCall, getCall, listCalls, newCallId } from "./api.ts";
import type { CallRecord } from "./api-types.ts";
import { voicemailSlot } from "./shared.ts";
import endCall from "./tools/end_call.ts";
import pressKeys from "./tools/press_keys.ts";
import call, {
  type CallEnded,
  type CallInput,
  RING_BUDGET_MS,
  RING_POLL_MS,
} from "./workflows/call.ts";

const SECRET = "test-calls-key";
const PROMPT =
  "Call Maria for Mission Dental to confirm her cleaning tomorrow at 2:30pm. " +
  "If she needs to reschedule, offer Thursday at 10am or Friday at 4pm.";

/** A request to one of the routes, authorized unless the case says otherwise. */
function request(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: "GET",
    path: "/v1/calls",
    params: {},
    query: {},
    headers: { authorization: SECRET },
    body: undefined,
    ...over,
  } as RouteRequest;
}

/** A route context over a stubbed workflow client. */
function routeContext(
  workflows = installStubWorkflows({ agent: agentDef }),
  env: Record<string, string> = { CALLS_API_KEY: SECRET },
) {
  return createRouteContext({ env, workflows });
}

/** What a thrown `routeError` carries, without naming its class. */
async function refusal(promise: unknown): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err: unknown) {
    return err as { status: number; message: string };
  }
  throw new Error("expected the route to refuse");
}

/** The call a session is on, as the phone bridge hands it in: this app's signed brief. */
async function placedCall(id: string, prompt = PROMPT, secret = SECRET): Promise<SessionCall> {
  const ctx = createToolContext({
    call: {
      carrier: "twilio",
      callId: "CA1",
      parameters: await signCallBrief({ id, prompt }, secret),
    },
  });
  const placed = sessionCall(ctx);
  if (placed === undefined) throw new Error("the context was given a call");
  return placed;
}

/**
 * What `onSessionEnd` is handed when the session `ctx` was on ends: the
 * session's own id and slots (so a fact a tool wrote during the call is
 * readable), the stubbed workflow client, and the lines said. Built over a
 * tool context rather than as a literal, so the next field the runtime adds to
 * `SessionEndContext` lands here once.
 */
function sessionEnd(
  ctx: TestToolContext,
  over: Partial<SessionEndContext> & Pick<SessionEndContext, "workflows">,
): SessionEndContext {
  return {
    sessionId: ctx.sessionId,
    env: { CALLS_API_KEY: SECRET },
    slots: ctx.slots,
    transcript: [],
    lastEventIndex: -1,
    ...over,
  };
}

describeAgent(agentDef, (run) => {
  test("answers Twilio calls and declares the call workflow and its routes", () => {
    expect(agentDef.telephony).toEqual(["twilio"]);
    expect(Object.keys(agentDef.workflows ?? {})).toContain("call");
    expect(Object.keys(agentDef.routes ?? {})).toEqual(
      expect.arrayContaining(["POST /v1/calls", "GET /v1/calls", "GET /v1/calls/:id"]),
    );
    // An outbound call: the person who answers speaks first.
    expect(agentDef.greeting).toBe("");
  });

  describe("POST /v1/calls", () => {
    const body = {
      phone_number: "+14155550132",
      prompt: PROMPT,
      webhook_url: "https://example.com/hooks/calls",
    };

    test("starts one run, keyed by the call id it answers with", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      const answer = (await createCall(
        request({ method: "POST", body }),
        routeContext(workflows),
      )) as { status: number; body: CallRecord };

      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({
        status: "queued",
        phone_number: body.phone_number,
        transcript: [],
      });
      expect(answer.body.id).toMatch(/^call_[0-9a-f]{16}$/);
      expect(workflows.start).toHaveBeenCalledWith(
        call,
        expect.objectContaining({ ...body, id: answer.body.id }),
        { key: answer.body.id, label: body.phone_number },
      );
    });

    test("accepts `Bearer <key>` as well as the bare key", async () => {
      const ctx = routeContext();
      await createCall(
        request({ method: "POST", body, headers: { authorization: `Bearer ${SECRET}` } }),
        ctx,
      );
      expect(ctx.workflows.start).toHaveBeenCalledOnce();
    });

    test("refuses a wrong key, and is off entirely without CALLS_API_KEY", async () => {
      const ctx = routeContext();
      expect(
        await createCall(
          request({ method: "POST", body, headers: { authorization: "nope" } }),
          ctx,
        ),
      ).toMatchObject({ status: 401 });
      expect(
        await createCall(request({ method: "POST", body }), routeContext(undefined, {})),
      ).toMatchObject({ status: 503, body: { error: expect.stringMatching(/CALLS_API_KEY/) } });
      expect(ctx.workflows.start).not.toHaveBeenCalled();
    });

    test("refuses a number that is not E.164 and a missing prompt, saying which", async () => {
      const ctx = routeContext();
      const refused = (await createCall(
        request({ method: "POST", body: { phone_number: "415-555-0132", prompt: " " } }),
        ctx,
      )) as { status: number; body: { error: string } };
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/E\.164/);
      expect(refused.body.error).toMatch(/prompt is required/);
      expect(ctx.workflows.start).not.toHaveBeenCalled();
    });

    test("mints a distinct id per call", () => {
      expect(new Set(Array.from({ length: 50 }, newCallId)).size).toBe(50);
    });
  });

  describe("GET /v1/calls/:id and GET /v1/calls", () => {
    test("a finished call is the run's output", async () => {
      const record: CallRecord = {
        id: "call_done",
        status: "completed",
        outcome: "answered",
        phone_number: "+14155550132",
        created_at: 1,
        duration_seconds: 74,
        summary: "Maria rebooked for Thursday at 10am.",
        transcript: [{ role: "agent", text: "Hi, is this Maria?" }],
      };
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(call, { key: "call_done", status: "completed", output: record })],
      });
      const ctx = routeContext(workflows);
      expect(await getCall(request({ params: { id: "call_done" } }), ctx)).toEqual(record);
      expect(workflows.find).toHaveBeenCalledWith(call, "call_done", { limit: 1 });
      expect(await listCalls(request(), ctx)).toEqual({ calls: [record] });
    });

    test("a call still going says where it is, in the run's own words", async () => {
      const workflows = installStubWorkflows({
        agent: agentDef,
        runs: [
          createRunSnapshot(call, {
            key: "call_live",
            status: "running",
            createdAt: 5,
            label: "+14155550132",
          }),
        ],
      });
      expect(
        await getCall(request({ params: { id: "call_live" } }), routeContext(workflows)),
      ).toEqual({
        id: "call_live",
        status: "queued",
        phone_number: "+14155550132",
        created_at: 5,
        transcript: [],
        summary: "+14155550132: dialled, waiting for the call to end.",
      });
    });

    test("a run that failed says why; an unknown id is a 404", async () => {
      const failed = installStubWorkflows({
        agent: agentDef,
        runs: [createRunSnapshot(call, { key: "call_bad", status: "failed", error: "boom" })],
      });
      expect(
        await getCall(request({ params: { id: "call_bad" } }), routeContext(failed)),
      ).toMatchObject({ status: "failed", error: "boom" });
      expect(
        await refusal(getCall(request({ params: { id: "call_none" } }), routeContext())),
      ).toMatchObject({ status: 404 });
    });
  });

  describe("the call brief", () => {
    test("sessionContext refuses an unsigned stream and briefs a signed one", async () => {
      const sessionContext = agentDef.sessionContext;
      if (sessionContext === undefined) throw new Error("the agent declares a sessionContext");
      const args = { env: { CALLS_API_KEY: SECRET }, signal: new AbortController().signal };

      expect(await sessionContext({ ...args, sessionId: "s_web" })).toMatchObject({
        refuse: expect.any(String),
      });
      expect(
        await sessionContext({
          ...args,
          sessionId: "s_stranger",
          call: await placedCall("call_1", PROMPT, "another-key"),
        }),
      ).toMatchObject({ refuse: expect.any(String) });

      expect(
        await sessionContext({ ...args, sessionId: "s_signed", call: await placedCall("call_1") }),
      ).toMatchObject({ greeting: "", instructions: expect.stringContaining(PROMPT) });
    });
  });

  describe("the session", () => {
    test("end_call hangs up", async () => {
      const ctx = createToolContext({ sessionId: "s_1" });
      const result = await run(endCall, {}, ctx);

      expect(result).toMatchObject({ ended: expect.any(Boolean) });
      expect(endSessionCalls(ctx)).toHaveLength(1);
      expect(voicemailSlot.get(ctx)).toBe(false);
    });

    test("end_call after a voicemail message records the fact for the session's end", async () => {
      const ctx = createToolContext({ sessionId: "s_1" });
      await run(endCall, { voicemail: true }, ctx);

      expect(endSessionCalls(ctx)).toHaveLength(1);
      expect(voicemailSlot.get(ctx)).toBe(true);
    });

    test("press_keys plays the keys into the call", async () => {
      const ctx = createToolContext({ sessionId: "s_1" });
      const result = await run(pressKeys, { keys: "2#" }, ctx);

      expect(result).toMatchObject({ pressed: "2#" });
      expect(sentDtmfCalls(ctx)).toEqual(["2#"]);
    });

    test("press_keys refuses a key no phone has, so the model can retry", async () => {
      const ctx = createToolContext({ sessionId: "s_1" });
      await expect(run(pressKeys, { keys: "one" }, ctx)).rejects.toThrow(/not a phone key/);
      expect(sentDtmfCalls(ctx)).toEqual([]);
    });

    test("press_keys sends the keys a model spells with spaces, commas or pauses", async () => {
      const ctx = createToolContext({ sessionId: "s_1" });
      await run(pressKeys, { keys: "2 0 4 #" }, ctx);
      await run(pressKeys, { keys: "0w2" }, ctx);
      expect(sentDtmfCalls(ctx)).toEqual(["204#", "0w2"]);
    });

    test("press_keys on a call that has ended says so", async () => {
      // A context whose session has no audio to play into — what `sendDtmf`
      // sees once the line has dropped.
      const ctx = { ...createToolContext({ sessionId: "s_1" }), sessionId: "s_gone" };
      expect(await run(pressKeys, { keys: "1" }, ctx)).toEqual({
        pressed: null,
        error: "The call has ended.",
      });
    });

    test("hands the transcript to the call's run as the session ends, by the call's key", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      const ctx = createToolContext({ sessionId: "s_1" });

      await agentDef.onSessionEnd?.(
        sessionEnd(ctx, {
          call: await placedCall("call_42"),
          workflows,
          transcript: [
            { role: "user", text: "Hello?", at: 1000 },
            { role: "assistant", text: "Hi, is this Maria?", at: 75_000 },
          ],
          lastEventIndex: 1,
        }),
      );

      // `signalRun` holds the payload for the run by default, so a call shorter
      // than one ring poll still reaches a run not yet parked on it.
      expect(workflows.signalRun).toHaveBeenCalledWith(call, "call_42", "callEnded", {
        transcript: [
          { role: "callee", text: "Hello?" },
          { role: "agent", text: "Hi, is this Maria?" },
        ],
        duration_seconds: 74,
        voicemail: false,
      });
    });

    test("the voicemail fact end_call wrote rides on the signal", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      const ctx = createToolContext({ sessionId: "s_vm" });
      await run(endCall, { voicemail: true }, ctx);

      await agentDef.onSessionEnd?.(
        sessionEnd(ctx, {
          call: await placedCall("call_43"),
          workflows,
          transcript: [{ role: "assistant", text: "Hi Maria, please call us back.", at: 1000 }],
          lastEventIndex: 0,
        }),
      );

      expect(workflows.signalRun).toHaveBeenCalledWith(
        call,
        "call_43",
        "callEnded",
        expect.objectContaining({ voicemail: true }),
      );
    });

    test("a session that was never a placed call hands nothing over", async () => {
      const workflows = installStubWorkflows({ agent: agentDef });
      await agentDef.onSessionEnd?.(
        sessionEnd(createToolContext({ sessionId: "s_none" }), { workflows }),
      );
      expect(workflows.signalRun).not.toHaveBeenCalled();
    });
  });

  describe("the run is DURABLE", () => {
    const INPUT: CallInput = {
      id: "call_7Hq2xK9mPz",
      phone_number: "+14155550132",
      prompt: PROMPT,
      webhook_url: "https://example.com/hooks/calls",
      created_at: 1_700_000_000_000,
    };
    const ENDED: CallEnded = {
      transcript: [
        { role: "agent", text: "Hi, is this Maria? I'm calling from Mission Dental." },
        { role: "callee", text: "Something came up at work. Anything later this week?" },
        { role: "agent", text: "I have Thursday at 10am or Friday at 4pm." },
        { role: "callee", text: "Thursday at 10 works." },
      ],
      duration_seconds: 74,
      voicemail: false,
    };
    const SUMMARY = "Maria rebooked for Thursday at 10am.";

    beforeEach(() => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
      vi.stubEnv("TWILIO_FROM_NUMBER", "+14155550100");
      vi.stubEnv("CALLS_API_KEY", SECRET);
      vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    });

    /** Twilio, the model and the webhook behind the one published `stepFetch`. */
    function stubWorld(options: Parameters<typeof stubPlaceCall>[0] = {}, summary = SUMMARY) {
      const model = stubGatewayRoute(JSON.stringify({ summary }));
      const webhook = vi.fn((_body: unknown) => ({ status: 204, body: "" }));
      const twilio = stubPlaceCall({
        status: (placed) => (placed.polls === 1 ? "ringing" : "in-progress"),
        publicUrl: "https://caller.example.com",
        ...options,
        otherwise: (req) =>
          model.route(req) ??
          webhook(
            JSON.parse(
              typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body),
            ),
          ),
      });
      onTestFinished(() => twilio.restore());
      return { twilio, model: model.calls, webhook };
    }

    // Keyed by the call id, as `POST /v1/calls` starts it: the key is what the
    // body's `waitForSignal` and the session's `signalRun` derive the token from.
    function start(options?: RunWorkflowOptions) {
      return runWorkflow(agentDef, "call", INPUT, { key: INPUT.id, ...options });
    }

    test("rings, parks on the call, and resumes on the session's signal into the finished record", async () => {
      const world = stubWorld();
      const handle = await start();

      // Suspended between ring polls, with the dial already journaled.
      expect(handle.status).toBe("running");
      expect(world.twilio.calls).toHaveLength(1);
      const placed = world.twilio.calls[0];
      expect(placed?.to).toBe(INPUT.phone_number);
      expect(placed?.webhookUrl).toBe("https://caller.example.com/phone?carrier=twilio");
      // The answering session can verify the brief it was handed.
      expect(await readCallBrief({ parameters: placed?.parameters ?? {} }, SECRET)).toEqual({
        id: INPUT.id,
        prompt: PROMPT,
      });

      await handle.advanceSleep(); // answered — now parked on the call
      expect(handle.status).toBe("running");

      await handle.signalRun("callEnded", ENDED);
      expect(handle.signalled).toBe(true);
      expect(handle.status).toBe("completed");

      const expected: CallRecord = {
        id: INPUT.id,
        status: "completed",
        phone_number: INPUT.phone_number,
        created_at: INPUT.created_at,
        outcome: "answered",
        duration_seconds: 74,
        summary: SUMMARY,
        transcript: ENDED.transcript,
      };
      expect(handle.output).toEqual(expected);
      expect(world.webhook).toHaveBeenCalledWith(expected);
      // One dial, one model call, across every suspension.
      expect(world.twilio.calls).toHaveLength(1);
      expect(world.model).toHaveLength(1);
    });

    test("a worker that dies after dialling resumes without ringing the phone again", async () => {
      const world = stubWorld();
      const handle = await start({ crashAt: "ring" }); // dies in the first ring poll
      await handle.restart(); // a new worker: the dial is journaled, the poll runs again
      await handle.advanceSleep();
      await handle.signalRun("callEnded", ENDED);

      expect(handle.status).toBe("completed");
      expect(world.twilio.calls).toHaveLength(1);
    });

    test("voicemail is the outcome when the session said it reached a machine", async () => {
      stubWorld({}, "Left a message asking Maria to call back.");
      const handle = await start();
      await handle.advanceSleep();
      await handle.signalRun("callEnded", { ...ENDED, voicemail: true });
      expect(handle.output).toMatchObject({ outcome: "voicemail" });
    });

    test("nobody answering completes as no-answer, with no model call", async () => {
      const world = stubWorld({ status: "no-answer" });
      const handle = await start();

      expect(handle.status).toBe("completed");
      expect(handle.output).toMatchObject({ outcome: "no-answer", transcript: [] });
      expect(world.model).toHaveLength(0);
      expect(world.webhook).toHaveBeenCalledOnce();
    });

    test("a phone that only ever rings gives up once the ring budget is spent", async () => {
      stubWorld({ status: "ringing" });
      const handle = await start();
      for (let i = 0; i < RING_BUDGET_MS / RING_POLL_MS; i++) await handle.advanceSleep();
      expect(handle.output).toMatchObject({ outcome: "no-answer" });
    });

    test("a dial Twilio refuses completes as failed, with Twilio's reason", async () => {
      const world = stubWorld({ dial: { status: 400, code: 21_219, message: "unverified" } });
      const handle = await start();

      expect(handle.status).toBe("completed");
      expect(handle.output).toMatchObject({ outcome: "failed", error: expect.any(String) });
      // Not retried: a refusal asks the same way next time.
      expect(world.twilio.calls).toHaveLength(1);
    });

    test("a transcript that never arrives closes the window instead of hanging", async () => {
      stubWorld();
      const handle = await start();
      await handle.advanceSleep();
      await handle.expireWaits();

      expect(handle.status).toBe("completed");
      expect(handle.output).toMatchObject({
        outcome: "answered",
        error: expect.stringMatching(/transcript/),
      });
    });
  });
});
