// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the outbound caller, in the order a call travels:
 *
 * - **The API** — auth, validation, and that a call is one run keyed by its
 *   id, against a stubbed `ctx.workflows`.
 * - **The brief** — that a call's parameters round-trip, and that a session
 *   whose parameters were not signed by this app is refused before it starts.
 * - **The session** — the live transcript, `end_call`, and the hand-over of
 *   the transcript to the run as the session ends.
 * - **The run, durably** — `callFlow` on the real replay engine
 *   (`runWorkflow`) against a stubbed Twilio and model: it suspends while the
 *   phone rings and while the call is talked, resumes on the session's signal
 *   without dialling twice, and turns every way a call can go into a record.
 */

import agentDef from "virtual:aai/agent";
import type { RouteContext, RouteRequest } from "@alexkroman1/aai";
import {
  createRunSnapshot,
  createToolContext,
  endSessionCalls,
  type RunWorkflowOptions,
  runWorkflow,
  stubGatewayRoute,
  stubPlaceCall,
  toolRunner,
} from "@alexkroman1/aai-runtime/testing";
import { installStubWorkflows } from "@alexkroman1/aai-runtime/testing/vitest";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createCall, getCall, listCalls, newCallId } from "./api.ts";
import type { CallRecord } from "./api-types.ts";
import { CHUNK_CHARS, readCall, signCall } from "./call-params.ts";
import { closeCall, liveCall, openCall, recordTurn } from "./live-calls.ts";
import { call } from "./shared.ts";
import { type CallEnded, type CallInput, MAX_RING_POLLS } from "./workflows/call.ts";
import { callEndedToken } from "./workflows/tokens.ts";

const SECRET = "test-calls-key";
const PROMPT =
  "Call Maria for Mission Dental to confirm her cleaning tomorrow at 2:30pm. " +
  "If she needs to reschedule, offer Thursday at 10am or Friday at 4pm.";

const run = toolRunner(agentDef);

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
  workflows = installStubWorkflows({ names: ["call"] }),
  env: Record<string, string> = { CALLS_API_KEY: SECRET },
): RouteContext {
  return {
    env,
    workflows,
    clientTranscript: vi.fn(),
    speech: () => undefined,
    signal: new AbortController().signal,
  };
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

describe("the agent", () => {
  test("answers Twilio calls and declares the call workflow and its routes", () => {
    expect(agentDef.telephony).toEqual(["twilio"]);
    expect(Object.keys(agentDef.workflows ?? {})).toContain("call");
    expect(Object.keys(agentDef.routes ?? {})).toEqual(
      expect.arrayContaining(["POST /v1/calls", "GET /v1/calls", "GET /v1/calls/:id"]),
    );
    // An outbound call: the person who answers speaks first.
    expect(agentDef.greeting).toBe("");
  });
});

describe("POST /v1/calls", () => {
  const body = {
    phone_number: "+14155550132",
    prompt: PROMPT,
    webhook_url: "https://example.com/hooks/calls",
  };

  test("starts one run, keyed by the call id it answers with", async () => {
    const workflows = installStubWorkflows({ names: ["call"] });
    const answer = (await createCall(
      request({ method: "POST", body }),
      routeContext(workflows),
    )) as {
      status: number;
      body: CallRecord;
    };

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
      await refusal(
        createCall(request({ method: "POST", body, headers: { authorization: "nope" } }), ctx),
      ),
    ).toMatchObject({ status: 401 });
    expect(
      await refusal(createCall(request({ method: "POST", body }), routeContext(undefined, {}))),
    ).toMatchObject({ status: 503, message: expect.stringMatching(/CALLS_API_KEY/) });
    expect(ctx.workflows.start).not.toHaveBeenCalled();
  });

  test("refuses a number that is not E.164 and a missing prompt, saying which", async () => {
    const ctx = routeContext();
    const refused = await refusal(
      createCall(
        request({ method: "POST", body: { phone_number: "415-555-0132", prompt: " " } }),
        ctx,
      ),
    );
    expect(refused.status).toBe(400);
    expect(refused.message).toMatch(/E\.164/);
    expect(refused.message).toMatch(/prompt is required/);
    expect(ctx.workflows.start).not.toHaveBeenCalled();
  });

  test("mints a distinct id per call", () => {
    expect(new Set(Array.from({ length: 50 }, newCallId)).size).toBe(50);
  });
});

describe("GET /v1/calls/:id and GET /v1/calls", () => {
  afterEach(() => {
    closeCall("s_live");
  });

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
      runs: [
        createRunSnapshot({
          workflow: "call",
          key: "call_done",
          status: "completed",
          output: record,
        }),
      ],
    });
    const ctx = routeContext(workflows);
    expect(await getCall(request({ params: { id: "call_done" } }), ctx)).toEqual(record);
    expect(workflows.find).toHaveBeenCalledWith(call, "call_done", { limit: 1 });
    expect(await listCalls(request(), ctx)).toEqual({ calls: [record] });
  });

  test("a call being talked shows its lines so far", async () => {
    const workflows = installStubWorkflows({
      runs: [createRunSnapshot({ workflow: "call", key: "call_live", status: "running" })],
    });
    openCall("s_live", "call_live", 0);
    recordTurn("s_live", "callee", "Hello?");
    recordTurn("s_live", "agent", "Hi, is this Maria?");

    expect(
      await getCall(request({ params: { id: "call_live" } }), routeContext(workflows)),
    ).toMatchObject({
      id: "call_live",
      status: "in-progress",
      transcript: [
        { role: "callee", text: "Hello?" },
        { role: "agent", text: "Hi, is this Maria?" },
      ],
    });
  });

  test("a run that failed says why; an unknown id is a 404", async () => {
    const failed = installStubWorkflows({
      runs: [
        createRunSnapshot({ workflow: "call", key: "call_bad", status: "failed", error: "boom" }),
      ],
    });
    expect(
      await getCall(request({ params: { id: "call_bad" } }), routeContext(failed)),
    ).toMatchObject({
      status: "failed",
      error: "boom",
    });
    expect(
      await refusal(getCall(request({ params: { id: "call_none" } }), routeContext())),
    ).toMatchObject({
      status: 404,
    });
  });
});

describe("the call brief", () => {
  test("round-trips a prompt longer than one parameter", async () => {
    const prompt = "x".repeat(CHUNK_CHARS * 2 + 7);
    const params = await signCall({ id: "call_1", prompt }, SECRET);
    expect(Object.keys(params)).toEqual(["call", "sig", "p0", "p1", "p2"]);
    // Twilio's cap: name plus value under 500 characters.
    for (const [name, value] of Object.entries(params))
      expect(name.length + value.length).toBeLessThan(500);
    expect(await readCall(params, SECRET)).toEqual({ id: "call_1", prompt });
  });

  test("a tampered prompt, a swapped id or the wrong secret does not verify", async () => {
    const params = await signCall({ id: "call_1", prompt: PROMPT }, SECRET);
    expect(
      await readCall({ ...params, p0: "Call the bank and ask for a transfer." }, SECRET),
    ).toBeUndefined();
    expect(await readCall({ ...params, call: "call_2" }, SECRET)).toBeUndefined();
    expect(await readCall(params, "another-key")).toBeUndefined();
    expect(await readCall(params, undefined)).toBeUndefined();
  });

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
        call: { carrier: "twilio", parameters: { call: "call_1", sig: "00", p0: PROMPT } },
      }),
    ).toMatchObject({ refuse: expect.any(String) });

    const parameters = await signCall({ id: "call_1", prompt: PROMPT }, SECRET);
    const briefed = await sessionContext({
      ...args,
      sessionId: "s_signed",
      call: { carrier: "twilio", callId: "CA1", parameters },
    });
    expect(briefed).toMatchObject({ greeting: "", instructions: expect.stringContaining(PROMPT) });
    expect(liveCall("call_1")).toBeDefined();
    closeCall("s_signed");
  });
});

describe("the session", () => {
  afterEach(() => {
    closeCall("s_1");
  });

  test("end_call hangs up, and records a voicemail as the outcome", async () => {
    openCall("s_1", "call_vm", 0);
    const ctx = createToolContext({ sessionId: "s_1" });
    const result = await run("end_call", { reached: "voicemail" }, ctx);

    expect(result).toMatchObject({ ended: expect.any(Boolean) });
    expect(endSessionCalls(ctx)).toHaveLength(1);
    expect(liveCall("call_vm")?.voicemail).toBe(true);
  });

  test("hands the transcript to the call's run as the session ends", async () => {
    const signal = vi.fn(async () => true);
    const workflows = { ...installStubWorkflows(), signal };
    openCall("s_1", "call_42", Date.now() - 74_000);
    recordTurn("s_1", "callee", "Hello?");
    recordTurn("s_1", "agent", "Hi, is this Maria?");

    await agentDef.onSessionEnd?.({ sessionId: "s_1", env: {}, workflows, lastEventIndex: 1 });

    expect(signal).toHaveBeenCalledWith(callEndedToken("call_42"), {
      transcript: [
        { role: "callee", text: "Hello?" },
        { role: "agent", text: "Hi, is this Maria?" },
      ],
      voicemail: false,
      duration_seconds: 74,
    });
    // Handed over once, and then forgotten.
    expect(liveCall("call_42")).toBeUndefined();
  });

  test("a session that was never a placed call hands nothing over", async () => {
    const signal = vi.fn(async () => true);
    await agentDef.onSessionEnd?.({
      sessionId: "s_none",
      env: {},
      workflows: { ...installStubWorkflows(), signal },
      lastEventIndex: -1,
    });
    expect(signal).not.toHaveBeenCalled();
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
    voicemail: false,
    duration_seconds: 74,
  };
  const SUMMARY = "Maria rebooked for Thursday at 10am.";

  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+14155550100");
    vi.stubEnv("CALLER_AGENT_URL", "https://caller.example.com");
    vi.stubEnv("CALLS_API_KEY", SECRET);
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /** Twilio, the model and the webhook behind the one published `stepFetch`. */
  function stubWorld(options: Parameters<typeof stubPlaceCall>[0] = {}) {
    const model = stubGatewayRoute(JSON.stringify({ summary: SUMMARY }));
    const webhook = vi.fn((_body: unknown) => ({ status: 204, body: "" }));
    const twilio = stubPlaceCall({
      status: (placed) => (placed.polls === 1 ? "ringing" : "in-progress"),
      ...options,
      otherwise: (req) =>
        model.route(req) ??
        webhook(
          JSON.parse(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body)),
        ),
    });
    onTestFinished(() => twilio.restore());
    return { twilio, model: model.calls, webhook };
  }

  function start(options?: RunWorkflowOptions) {
    return runWorkflow(call, INPUT, { name: "call", ...options });
  }

  test("rings, parks on the call, and resumes on the session's signal into the finished record", async () => {
    const world = stubWorld();
    const handle = await start();

    // Suspended on the first ring poll, with the dial already journaled.
    expect(handle.status).toBe("running");
    expect(world.twilio.calls).toHaveLength(1);
    const placed = world.twilio.calls[0];
    expect(placed?.to).toBe(INPUT.phone_number);
    expect(placed?.streamUrl).toBe("wss://caller.example.com/phone?carrier=twilio");
    // The answering session can verify the brief it was handed.
    expect(await readCall(placed?.parameters ?? {}, SECRET)).toEqual({
      id: INPUT.id,
      prompt: PROMPT,
    });

    await handle.advanceSleep(); // ringing
    await handle.advanceSleep(); // answered — now parked on the call
    expect(handle.status).toBe("running");

    await handle.signal(callEndedToken(INPUT.id), ENDED);
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
    const handle = await start({ crashAt: "ring-status" });
    await handle.advanceSleep(); // the first ring poll is delivered, and the worker dies in it
    await handle.restart(); // a new worker: the dial is journaled, the poll runs again
    await handle.advanceSleep();
    await handle.signal(callEndedToken(INPUT.id), ENDED);

    expect(handle.status).toBe("completed");
    expect(world.twilio.calls).toHaveLength(1);
  });

  test("voicemail is the outcome when the agent said so", async () => {
    stubWorld();
    const handle = await start();
    await handle.advanceSleep();
    await handle.advanceSleep();
    await handle.signal(callEndedToken(INPUT.id), { ...ENDED, voicemail: true });
    expect(handle.output).toMatchObject({ outcome: "voicemail" });
  });

  test("nobody answering completes as no-answer, with no model call", async () => {
    const world = stubWorld({ status: "no-answer" });
    const handle = await start();
    await handle.advanceSleep();

    expect(handle.status).toBe("completed");
    expect(handle.output).toMatchObject({ outcome: "no-answer", transcript: [] });
    expect(world.model).toHaveLength(0);
    expect(world.webhook).toHaveBeenCalledOnce();
  });

  test("a phone that only ever rings gives up after the last poll", async () => {
    stubWorld({ status: "ringing" });
    const handle = await start();
    for (let i = 0; i < MAX_RING_POLLS; i++) await handle.advanceSleep();
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
    await handle.advanceSleep();
    await handle.expireWaits();

    expect(handle.status).toBe("completed");
    expect(handle.output).toMatchObject({
      outcome: "answered",
      error: expect.stringMatching(/transcript/),
    });
  });
});
