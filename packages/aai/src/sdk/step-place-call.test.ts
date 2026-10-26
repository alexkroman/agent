// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { toStepError } from "./_step-verdict.ts";

import { phoneWebhookUrl } from "./phone-webhook.ts";
import { publishStepEnv } from "./step-env.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import {
  CALL_OVER_STATUSES,
  DEFAULT_CALL_RING_TIMEOUT_S,
  DEFAULT_CALL_TIME_LIMIT_S,
  isCallOver,
  PlaceCallError,
  type PlacedCallStatus,
  publishStepPublicUrl,
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

afterEach(() => {
  publishStepEnv(undefined);
  publishStepPublicUrl(undefined);
});

async function refusedWith(status: number, body: object): Promise<PlaceCallError> {
  installStubStepFetch(() => ({ status, body }));
  const err = await stepPlaceCall(dial).catch((e: unknown) => e);
  if (!(err instanceof PlaceCallError))
    throw new Error(`expected a PlaceCallError, got ${String(err)}`);
  return err;
}

describe("stepPlaceCall", () => {
  test("posts the form to the account's Calls.json, pointing the answered call at /phone", async () => {
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
    // A webhook, never inline TwiML: only a webhook works on the managed
    // platform (phone-webhook.ts).
    expect(form.get("Twiml")).toBeNull();
    expect(form.get("Method")).toBe("POST");
    expect(form.get("Url")).toBe(
      "https://caller.example.test/phone?carrier=twilio&param.call=call_1",
    );
  });

  test("a brief rides on the call as signed parameters the answering session reads back", async () => {
    const { readCallBrief } = await import("./call-brief.ts");
    const { callParametersFromQuery } = await import("./phone-webhook.ts");
    publishStepEnv({ CALLS_API_KEY: "brief-secret" });
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA7" } }));
    await stepPlaceCall({
      ...dial,
      parameters: { for: "Sam" },
      brief: { id: "call_7", prompt: "Book a table for two." },
    });
    const url = new URL(new URLSearchParams(String(twilio.calls[0]?.body)).get("Url") ?? "");
    const parameters = callParametersFromQuery(url.searchParams);
    expect(parameters.for).toBe("Sam");
    expect(parameters.call).toBe("call_7");
    expect(await readCallBrief({ parameters }, "brief-secret")).toEqual({
      id: "call_7",
      prompt: "Book a table for two.",
    });
    expect(await readCallBrief({ parameters }, "other")).toBeUndefined();
  });

  test("a brief with no secret in the env, or over a reserved parameter, is refused before dialling", async () => {
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA7" } }));
    publishStepEnv({});
    const unset = await stepPlaceCall({ ...dial, brief: { id: "c", prompt: "p" } }).catch(
      (e: unknown) => e,
    );
    expect(unset).toMatchObject({ retryable: false });
    expect(String(unset)).toMatch(/CALLS_API_KEY is not set/);
    publishStepEnv({ CALL_SECRET: "s" });
    const named = await stepPlaceCall({
      ...dial,
      brief: { id: "c", prompt: "p" },
      briefSecretEnv: "CALL_SECRET",
      parameters: { sig: "forged" },
    }).catch((e: unknown) => e);
    expect(String(named)).toMatch(/parameters\.sig collides/);
    expect(twilio.calls).toHaveLength(0);
  });

  test("an empty briefSecretEnv means the default, never an empty name", async () => {
    installStubStepFetch(() => ({ status: 201, body: { sid: "CA7" } }));
    publishStepEnv({});
    const err = await stepPlaceCall({
      ...dial,
      brief: { id: "c", prompt: "p" },
      briefSecretEnv: "",
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/CALLS_API_KEY is not set/);
  });

  test("the brief is checked before the credentials, so an oversized prompt is named as such", async () => {
    installStubStepFetch(() => ({ status: 201, body: { sid: "CA7" } }));
    publishStepEnv({});
    const { credentials: _, ...noCredentials } = dial;
    const err = await stepPlaceCall({
      ...noCredentials,
      brief: { id: "c", prompt: "x".repeat(5000) },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaceCallError);
    expect(String(err)).toMatch(/prompt is at most 4000/);
    expect(String(err)).not.toMatch(/Twilio is not set up/);
  });

  test("a brief that overflows the parameter budget is refused in terms of the brief", async () => {
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA7" } }));
    publishStepEnv({ CALLS_API_KEY: "s" });
    const own = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`k${i}`, "v"]));
    const err = await stepPlaceCall({
      ...dial,
      parameters: own,
      brief: { id: "c", prompt: "x".repeat(4000) },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect(String(err)).toMatch(/33 parameters/);
    expect(String(err)).toMatch(/the brief takes up to 11/);
    expect(twilio.calls).toHaveLength(0);
  });

  test("defaults agentUrl to the published public URL, and refuses with none", async () => {
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA1" } }));
    const { agentUrl: _, ...noUrl } = dial;
    const none = await stepPlaceCall(noUrl).catch((e: unknown) => e);
    expect(none).toMatchObject({ retryable: false });
    expect(String(none)).toMatch(/aai dev --tunnel/);
    publishStepPublicUrl("https://platform.test/my-agent");
    await stepPlaceCall(noUrl);
    expect(new URLSearchParams(String(twilio.calls[0]?.body)).get("Url")).toBe(
      phoneWebhookUrl("https://platform.test/my-agent", "twilio", {}),
    );
  });

  test("refuses a loopback agentUrl, which Twilio can never reach", async () => {
    const twilio = installStubStepFetch(() => ({ status: 201, body: { sid: "CA1" } }));
    for (const agentUrl of [
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
    ]) {
      const err = await stepPlaceCall({ ...dial, agentUrl }).catch((e: unknown) => e);
      expect(err, agentUrl).toMatchObject({ retryable: false });
      expect(String(err)).toMatch(/loopback/);
    }
    expect(twilio.calls).toEqual([]);
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
      await expect(stepPlaceCall(options), JSON.stringify(options)).rejects.toMatchObject({
        retryable: false,
      });
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
    for (const status of live) expect(isCallOver(status), String(status)).toBe(false);
    for (const status of CALL_OVER_STATUSES) expect(isCallOver(status), String(status)).toBe(true);
  });

  test("an unknown status is not over", () => {
    expect(isCallOver("initiated")).toBe(false);
    expect(isCallOver("")).toBe(false);
  });
});
