// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { toStepError } from "./_step-verdict.ts";

import { callTwiml } from "./_twilio-calls.ts";
import { publishStepEnv } from "./step-env.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import {
  CALL_OVER_STATUSES,
  DEFAULT_CALL_RING_TIMEOUT_S,
  DEFAULT_CALL_TIME_LIMIT_S,
  isCallOver,
  PlaceCallError,
  type PlacedCallStatus,
  stepCallStatus,
  stepPlaceCall,
} from "./step-place-call.ts";
import { installStubStepFetch } from "./testing-vitest.ts";

// Fictional values throughout: 555-01xx numbers, a made-up SID and token.
const TOKEN = "tok-secret-9f2c";
const SID = "AC0000000000000000000000000000ab";
const credentials = { accountSid: SID, authToken: TOKEN };
const dial = {
  carrier: "twilio" as const,
  to: "+15555550177",
  from: "+15555550100",
  agentUrl: "https://caller.example.test",
  credentials,
};

afterEach(() => publishStepEnv(undefined));

async function refusedWith(status: number, body: object): Promise<PlaceCallError> {
  installStubStepFetch(() => ({ status, body }));
  const err = await stepPlaceCall(dial).catch((e: unknown) => e);
  if (!(err instanceof PlaceCallError))
    throw new Error(`expected a PlaceCallError, got ${String(err)}`);
  return err;
}

describe("stepPlaceCall", () => {
  test("posts the form to the account's Calls.json, streaming the answered call to /phone", async () => {
    const twilio = installStubStepFetch(() => ({
      status: 201,
      body: { sid: "CA123", status: "queued" },
    }));
    expect(await stepPlaceCall({ ...dial, parameters: { call: "call_1" } })).toEqual({
      callId: "CA123",
    });
    const [request] = twilio.calls;
    expect(request?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.Authorization).toBe(`Basic ${btoa(`${SID}:${TOKEN}`)}`);
    const form = new URLSearchParams(String(request?.body));
    expect(form.get("To")).toBe("+15555550177");
    expect(form.get("From")).toBe("+15555550100");
    expect(form.get("TimeLimit")).toBe(String(DEFAULT_CALL_TIME_LIMIT_S));
    expect(form.get("Timeout")).toBe(String(DEFAULT_CALL_RING_TIMEOUT_S));
    expect(form.get("Twiml")).toBe(
      callTwiml("wss://caller.example.test/phone?carrier=twilio", { call: "call_1" }),
    );
  });

  test("reads the credentials from the step env when none are passed", async () => {
    publishStepEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN });
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA9" } }));
    const { credentials: _, ...fromEnv } = dial;
    await stepPlaceCall(fromEnv);
    expect(twilio.calls[0]?.headers.Authorization).toBe(`Basic ${btoa(`${SID}:${TOKEN}`)}`);
  });

  test("missing credentials name both env keys and are not retryable", async () => {
    publishStepEnv({});
    const { credentials: _, ...fromEnv } = dial;
    const err = await stepPlaceCall(fromEnv).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect(String(err)).toMatch(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
  });

  test.each<[number, number, RegExp]>([
    [401, 20_003, /account SID or auth token/],
    [400, 21_211, /isn't a phone number/],
    [400, 21_217, /isn't a phone number/],
    [400, 21_210, /number to call from/],
    [400, 21_212, /number to call from/],
    [400, 21_219, /trial account/],
    [400, 21_215, /geographic permissions/],
  ])("HTTP %i with Twilio code %i advises %s, not retryable", async (status, code, advice) => {
    const err = await refusedWith(status, { code, message: "raw" });
    expect(err.message).toMatch(advice);
    expect(err).toMatchObject({ status, code, retryable: false });
  });

  test("an unknown code quotes Twilio; retryable only for 429 and 5xx", async () => {
    const other = await refusedWith(400, { code: 13_224, message: "Invalid timeout" });
    expect(other.message).toContain("Invalid timeout");
    expect((await refusedWith(429, {})).retryable).toBe(true);
    expect((await refusedWith(503, { message: "down" })).retryable).toBe(true);
    expect((await refusedWith(408, {})).retryable).toBe(false);
  });

  test("never quotes the token, even when Twilio's answer does", async () => {
    const basic = btoa(`${SID}:${TOKEN}`);
    const err = await refusedWith(400, { message: `bad auth ${TOKEN} / ${basic}` });
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(basic);
    expect(err.message).toContain("[redacted]");
  });

  test("a request that never got an answer is retryable, and the verdicts classify", async () => {
    installStubStepFetch(() => {
      throw new Error(`socket hang up ${TOKEN}`);
    });
    const lost = await stepPlaceCall(dial).catch((e: unknown) => e);
    expect(lost).toMatchObject({ retryable: true, status: undefined });
    expect(String(lost)).not.toContain(TOKEN);
    expect(toStepError(lost)).toBeInstanceOf(RetryableError);
    const trial = await refusedWith(400, { code: 21_219 });
    expect(toStepError(trial)).toBeInstanceOf(FatalError);
  });

  test("an accepted dial with no SID is not retried, since the phone may be ringing", async () => {
    installStubStepFetch(() => ({ status: 201, body: {} }));
    await expect(stepPlaceCall(dial)).rejects.toMatchObject({ retryable: false });
  });

  test("refuses a malformed request before dialling", async () => {
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA1" } }));
    const bad = [
      { ...dial, agentUrl: "ftp://x.test" },
      { ...dial, agentUrl: "https://x.test/?token=1" },
      { ...dial, to: " " },
      { ...dial, timeLimitS: 0 },
      { ...dial, ringTimeoutS: 1.5 },
      { ...dial, parameters: { call: "x".repeat(500) } },
      {
        ...dial,
        parameters: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, "v"])),
      },
    ];
    for (const options of bad) {
      await expect(stepPlaceCall(options)).rejects.toMatchObject({ retryable: false });
    }
    expect(twilio.calls).toHaveLength(0);
  });

  test("Telnyx is refused by name: twilio only for now", async () => {
    await expect(stepPlaceCall({ ...dial, carrier: "telnyx" as "twilio" })).rejects.toMatchObject({
      retryable: false,
      carrier: "telnyx",
      message: expect.stringMatching(/Twilio only for now/),
    });
  });
});

describe("stepCallStatus", () => {
  test("reads the call and normalizes its status", async () => {
    const twilio = installStubStepFetch(() => ({ body: { sid: "CA1", status: "no-answer" } }));
    expect(await stepCallStatus({ carrier: "twilio", callId: "CA1", credentials })).toBe(
      "no-answer",
    );
    expect(twilio.calls[0]).toMatchObject({
      method: "GET",
      url: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/CA1.json`,
    });
    installStubStepFetch(() => ({ body: { status: "initiated" } }));
    expect(await stepCallStatus({ carrier: "twilio", callId: "CA1", credentials })).toBe("queued");
  });

  test("a status this SDK does not know is a refusal naming it", async () => {
    installStubStepFetch(() => ({ body: { status: "teleported" } }));
    await expect(stepCallStatus({ carrier: "twilio", callId: "CA1", credentials })).rejects.toThrow(
      /teleported/,
    );
  });
});

describe("isCallOver", () => {
  test("the five terminal statuses, and nothing else, are over", () => {
    expect([...CALL_OVER_STATUSES].sort()).toEqual(
      ["busy", "canceled", "completed", "failed", "no-answer"].sort(),
    );
    const live: PlacedCallStatus[] = ["queued", "ringing", "in-progress"];
    for (const status of live) expect(isCallOver(status)).toBe(false);
    for (const status of CALL_OVER_STATUSES) expect(isCallOver(status)).toBe(true);
  });

  test("an unknown status is not over", () => {
    expect(isCallOver("initiated")).toBe(false);
    expect(isCallOver("")).toBe(false);
  });
});
