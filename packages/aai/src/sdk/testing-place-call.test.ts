// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { stepFetch } from "./step-fetch.ts";
import { PlaceCallError, stepCallStatus, stepPlaceCall } from "./step-place-call.ts";
import { type StubPlaceCall, stubPlaceCall } from "./testing-place-call.ts";

const credentials = { accountSid: "AC00000000000000000000000000000001", authToken: "t" };
const dial = {
  carrier: "twilio" as const,
  to: "+15555550177",
  from: "+15555550100",
  agentUrl: "https://caller.example.test",
  credentials,
};

let twilio: StubPlaceCall | undefined;
afterEach(() => twilio?.restore());

describe("stubPlaceCall", () => {
  test("records each dial as the answering session would see it, and answers a call id", async () => {
    twilio = stubPlaceCall();
    const { callId } = await stepPlaceCall({
      ...dial,
      parameters: { call: `c"1<&>` },
      timeLimitS: 120,
    });
    expect(twilio.calls).toEqual([
      {
        callId,
        to: "+15555550177",
        from: "+15555550100",
        streamUrl: "wss://caller.example.test/phone?carrier=twilio",
        parameters: { call: `c"1<&>` },
        timeLimitS: 120,
        ringTimeoutS: 30,
        polls: 0,
      },
    ]);
    expect(callId).toMatch(/^CA\d{32}$/);
  });

  test("status reads follow the call, counting polls", async () => {
    twilio = stubPlaceCall({ status: (call) => (call.polls < 3 ? "ringing" : "completed") });
    const { callId } = await stepPlaceCall(dial);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++)
      seen.push(await stepCallStatus({ carrier: "twilio", callId, credentials }));
    expect(seen).toEqual(["ringing", "ringing", "completed"]);
    expect(twilio.calls[0]?.polls).toBe(3);
  });

  test("a staged refusal goes through the SDK's own classification", async () => {
    twilio = stubPlaceCall({ dial: { status: 400, code: 21_219 } });
    const err = await stepPlaceCall(dial).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaceCallError);
    expect(err).toMatchObject({ code: 21_219, retryable: false });
    expect(twilio.calls[0]?.callId).toBeUndefined();
  });

  test("anything else goes to `otherwise`, and with none it is a finding", async () => {
    twilio = stubPlaceCall({ otherwise: () => ({ body: { ok: true } }) });
    expect(await (await stepFetch("https://db.example.test/rows")).json()).toEqual({ ok: true });
    twilio.restore();
    twilio = stubPlaceCall();
    await expect(stepFetch("https://db.example.test/rows")).rejects.toThrow(/no route/);
  });
});
