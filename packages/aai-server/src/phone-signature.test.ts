// Copyright 2026 the AAI authors. MIT license.
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  verifyPhoneWebhook,
  verifyTelnyxSignature,
  verifyTwilioSignature,
} from "./phone-signature.ts";

const AUTH_TOKEN = "12345678901234567890123456789012";
const URL_UNDER_TEST = "https://platform.test/my-agent/phone";

/**
 * Twilio's documented signing: HMAC-SHA1 over the URL with each POST
 * parameter appended as `name + value`, sorted by name.
 *
 * Written out here rather than reusing the implementation — a self-consistent
 * signer would make every one of these tests pass against a wrong algorithm.
 */
function twilioSignature(url: string, params: Record<string, string>): string {
  let payload = url;
  for (const name of Object.keys(params).sort()) payload += name + params[name];
  return createHmac("sha1", AUTH_TOKEN).update(payload, "utf-8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  const params = { CallSid: "CA1", From: "+15551234567", To: "+15557654321" };
  const body = new URLSearchParams(params);

  test("accepts a correctly signed request", () => {
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: body,
      signature: twilioSignature(URL_UNDER_TEST, params),
    });
    expect(verdict).toEqual({ ok: true });
  });

  test("rejects a request with no signature header", () => {
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: body,
      signature: null,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("rejects a signature computed over a different URL", () => {
    // The case that matters behind a TLS-terminating proxy: signing over the
    // container-visible `http://` URL instead of the public one.
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: body,
      signature: twilioSignature("http://platform.test/my-agent/phone", params),
    });
    expect(verdict).toMatchObject({ ok: false, reason: "bad signature" });
  });

  test("rejects a tampered parameter", () => {
    const signature = twilioSignature(URL_UNDER_TEST, params);
    const tampered = new URLSearchParams({ ...params, From: "+15550000000" });
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: tampered,
      signature,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("rejects a signature made with a different auth token", () => {
    const other = createHmac("sha1", "wrong-token").update(URL_UNDER_TEST).digest("base64");
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: new URLSearchParams(),
      signature: other,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("is insensitive to parameter order on the wire", () => {
    // Twilio sorts by name; the body's own order is whatever the form
    // encoder produced, and must not change the outcome.
    const reordered = new URLSearchParams("To=%2B15557654321&CallSid=CA1&From=%2B15551234567");
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: reordered,
      signature: twilioSignature(URL_UNDER_TEST, params),
    });
    expect(verdict).toEqual({ ok: true });
  });

  test("handles a repeated parameter by including every value", () => {
    const repeated = new URLSearchParams("a=1&a=2");
    const expected = createHmac("sha1", AUTH_TOKEN)
      .update(`${URL_UNDER_TEST}a1a2`, "utf-8")
      .digest("base64");
    const verdict = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL_UNDER_TEST,
      params: repeated,
      signature: expected,
    });
    expect(verdict).toEqual({ ok: true });
  });
});

describe("verifyTelnyxSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    // Strip the 12-byte SPKI prefix — Telnyx publishes the bare 32 key bytes.
    .subarray(12)
    .toString("base64");
  const body = '{"data":{"event_type":"call.initiated"}}';
  const now = 1_800_000_000_000;
  const timestamp = String(Math.floor(now / 1000));

  function telnyxSignature(payload: string): string {
    return sign(null, Buffer.from(payload, "utf-8"), privateKey).toString("base64");
  }

  test("accepts a correctly signed request", () => {
    const verdict = verifyTelnyxSignature({
      publicKey: rawPublicKey,
      rawBody: body,
      signature: telnyxSignature(`${timestamp}|${body}`),
      timestamp,
      now,
    });
    expect(verdict).toEqual({ ok: true });
  });

  test("rejects a body that was modified after signing", () => {
    const verdict = verifyTelnyxSignature({
      publicKey: rawPublicKey,
      rawBody: '{"data":{"event_type":"call.hangup"}}',
      signature: telnyxSignature(`${timestamp}|${body}`),
      timestamp,
      now,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("rejects a replay outside the freshness window", () => {
    // Telnyx signs `timestamp|body`, so without this a captured request
    // stays valid forever.
    const verdict = verifyTelnyxSignature({
      publicKey: rawPublicKey,
      rawBody: body,
      signature: telnyxSignature(`${timestamp}|${body}`),
      timestamp,
      now: now + 10 * 60_000,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "stale telnyx-timestamp" });
  });

  test.each([
    ["a missing signature", { signature: null, timestamp }],
    ["a missing timestamp", { signature: "AAAA", timestamp: null }],
    ["a non-numeric timestamp", { signature: "AAAA", timestamp: "yesterday" }],
  ])("rejects %s", (_label, overrides) => {
    const verdict = verifyTelnyxSignature({
      publicKey: rawPublicKey,
      rawBody: body,
      now,
      ...overrides,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("reports a malformed public key as a rejection, not a crash", () => {
    // Operator typo, or attacker-supplied bytes — neither is a 500.
    const verdict = verifyTelnyxSignature({
      publicKey: "not-a-key",
      rawBody: body,
      signature: telnyxSignature(`${timestamp}|${body}`),
      timestamp,
      now,
    });
    expect(verdict).toMatchObject({ ok: false });
  });
});

describe("verifyPhoneWebhook", () => {
  const params = { CallSid: "CA1" };
  const rawBody = new URLSearchParams(params).toString();

  test("accepts anything when the agent has configured no secret", () => {
    // The documented default: the route is left exactly as open as
    // /websocket and /client-config beside it.
    const verdict = verifyPhoneWebhook({
      carrier: "twilio",
      env: { ASSEMBLYAI_API_KEY: "k" },
      url: URL_UNDER_TEST,
      rawBody,
      headers: new Headers(),
    });
    expect(verdict).toEqual({ ok: true });
  });

  test("accepts anything when the agent has no stored env at all", () => {
    const verdict = verifyPhoneWebhook({
      carrier: "twilio",
      env: null,
      url: URL_UNDER_TEST,
      rawBody,
      headers: new Headers(),
    });
    expect(verdict).toEqual({ ok: true });
  });

  test("enforces Twilio's signature once the auth token is stored", () => {
    const env = { TWILIO_AUTH_TOKEN: AUTH_TOKEN };
    const unsigned = verifyPhoneWebhook({
      carrier: "twilio",
      env,
      url: URL_UNDER_TEST,
      rawBody,
      headers: new Headers(),
    });
    expect(unsigned).toMatchObject({ ok: false });

    const signed = verifyPhoneWebhook({
      carrier: "twilio",
      env,
      url: URL_UNDER_TEST,
      rawBody,
      headers: new Headers({ "x-twilio-signature": twilioSignature(URL_UNDER_TEST, params) }),
    });
    expect(signed).toEqual({ ok: true });
  });

  test("does not apply Twilio's token to a Telnyx call", () => {
    // Each carrier's secret gates only its own scheme; a Twilio token says
    // nothing about a Telnyx request and must not be read as approval. It is
    // also not a reason to let the request THROUGH — see below.
    const verdict = verifyPhoneWebhook({
      carrier: "telnyx",
      env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
      url: URL_UNDER_TEST,
      rawBody,
      headers: new Headers({ "telnyx-signature-ed25519": "x", "telnyx-timestamp": "1" }),
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  test("a caller-named carrier cannot select the branch that checks nothing", () => {
    // The attack: `?carrier=` is a query parameter on an unauthenticated route,
    // so a caller picks which branch runs. Against an agent with only
    // TWILIO_AUTH_TOKEN stored, `carrier=telnyx` used to skip the Twilio branch
    // (carrier mismatch) AND the Telnyx branch (no TELNYX_PUBLIC_KEY) and fall
    // through to `{ ok: true }` — after which the route brokered a sandbox and
    // answered with the guest's auth-free media-stream URL.
    expect(
      verifyPhoneWebhook({
        carrier: "telnyx",
        env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
        url: URL_UNDER_TEST,
        rawBody,
        headers: new Headers(),
      }),
    ).toMatchObject({ ok: false });

    // Symmetric: a Telnyx-only agent is bypassed by OMITTING the parameter,
    // because the route defaults to `twilio`.
    expect(
      verifyPhoneWebhook({
        carrier: "twilio",
        env: { TELNYX_PUBLIC_KEY: "AAAA" },
        url: URL_UNDER_TEST,
        rawBody,
        headers: new Headers(),
      }),
    ).toMatchObject({ ok: false });

    // And an unrecognized carrier name is not a third way through. (The route
    // 400s this one before it gets here; the check does not rely on that.)
    expect(
      verifyPhoneWebhook({
        carrier: "not-a-carrier",
        env: { TWILIO_AUTH_TOKEN: AUTH_TOKEN },
        url: URL_UNDER_TEST,
        rawBody,
        headers: new Headers(),
      }),
    ).toMatchObject({ ok: false });
  });

  test("an agent running both carriers is checked on whichever it is called as", () => {
    const env = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, TELNYX_PUBLIC_KEY: "AAAA" };
    expect(
      verifyPhoneWebhook({
        carrier: "twilio",
        env,
        url: URL_UNDER_TEST,
        rawBody,
        headers: new Headers({ "x-twilio-signature": twilioSignature(URL_UNDER_TEST, params) }),
      }),
    ).toEqual({ ok: true });
    expect(
      verifyPhoneWebhook({
        carrier: "telnyx",
        env,
        url: URL_UNDER_TEST,
        rawBody,
        headers: new Headers(),
      }),
    ).toMatchObject({ ok: false });
  });
});
