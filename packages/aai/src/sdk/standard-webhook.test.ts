// Copyright 2026 the AAI authors. MIT license.
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createStubWorkflows } from "./_testing-context.ts";
import type { RouteContext, RouteRequest } from "./agent-routes.ts";
import { readRouteResponse } from "./agent-routes.ts";
import { verifyStandardWebhook, webhookRoute } from "./standard-webhook.ts";

const NOW = 1_790_000_000;
const RAW = '{"type":"composio.trigger.message","data":{"n":1}}';

function signed(key: Buffer | string, raw = RAW, ts = NOW, id = "msg_1"): string {
  return createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
}

function request(signature: string, over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: "POST",
    path: "/hook",
    params: {},
    query: {},
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(NOW),
      "webhook-signature": signature,
    },
    body: JSON.parse(RAW),
    rawBody: RAW,
    ...over,
  };
}

describe("verifyStandardWebhook", () => {
  test("accepts a plain secret signed over its UTF-8 bytes (Composio's form)", async () => {
    const secret = "plain-secret";
    expect(
      await verifyStandardWebhook(request(`v1,${signed(secret)}`), secret, { nowS: NOW }),
    ).toBe(true);
  });

  test("accepts a whsec_ secret signed with its base64-decoded key (the spec's form)", async () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    const secret = `whsec_${key.toString("base64")}`;
    expect(await verifyStandardWebhook(request(`v1,${signed(key)}`), secret, { nowS: NOW })).toBe(
      true,
    );
    // …and one signed over the whole string's bytes, as some senders do.
    expect(
      await verifyStandardWebhook(request(`v1,${signed(secret)}`), secret, { nowS: NOW }),
    ).toBe(true);
  });

  test("any of several signatures matches, as during a secret rotation", async () => {
    const header = `v1,${signed("old-secret")} v1,${signed("new-secret")}`;
    expect(await verifyStandardWebhook(request(header), "new-secret", { nowS: NOW })).toBe(true);
    expect(await verifyStandardWebhook(request(header), "other", { nowS: NOW })).toBe(false);
  });

  test("refuses a tampered body, a re-serialized body, a wrong secret and a non-v1 scheme", async () => {
    const sig = `v1,${signed("s")}`;
    const tampered = request(sig, { rawBody: RAW.replace("1", "2") });
    expect(await verifyStandardWebhook(tampered, "s", { nowS: NOW })).toBe(false);
    const reserialized = request(sig, { rawBody: JSON.stringify(JSON.parse(RAW), null, 1) });
    expect(await verifyStandardWebhook(reserialized, "s", { nowS: NOW })).toBe(false);
    expect(await verifyStandardWebhook(request(sig), "t", { nowS: NOW })).toBe(false);
    expect(await verifyStandardWebhook(request(`v1a,${signed("s")}`), "s", { nowS: NOW })).toBe(
      false,
    );
  });

  test("refuses a delivery outside the replay window, both directions", async () => {
    const sig = `v1,${signed("s")}`;
    expect(await verifyStandardWebhook(request(sig), "s", { nowS: NOW + 301 })).toBe(false);
    expect(await verifyStandardWebhook(request(sig), "s", { nowS: NOW - 301 })).toBe(false);
    expect(await verifyStandardWebhook(request(sig), "s", { nowS: NOW + 299 })).toBe(true);
    expect(await verifyStandardWebhook(request(sig), "s", { nowS: NOW + 50, toleranceS: 10 })).toBe(
      false,
    );
  });

  test("refuses missing headers, an empty secret, a missing raw body and a junk timestamp", async () => {
    const sig = `v1,${signed("s")}`;
    const base = request(sig);
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers = { ...base.headers };
      delete headers[name];
      expect
        .soft(await verifyStandardWebhook({ ...base, headers }, "s", { nowS: NOW }), name)
        .toBe(false);
    }
    expect(await verifyStandardWebhook(base, "", { nowS: NOW })).toBe(false);
    const { rawBody: _omit, ...noRaw } = base;
    expect(await verifyStandardWebhook(noRaw, "s", { nowS: NOW })).toBe(false);
    const junk = { ...base, headers: { ...base.headers, "webhook-timestamp": "1e9" } };
    expect(await verifyStandardWebhook(junk, "s", { nowS: 1e9 })).toBe(false);
  });
});

describe("webhookRoute", () => {
  const ctx = (env: Record<string, string>): RouteContext => ({
    env,
    workflows: createStubWorkflows(),
    clientTranscript: async () => ({ sessions: [] }),
    signal: new AbortController().signal,
  });

  test("runs the handler only for a verified delivery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = `v1,${signed("s", RAW, now)}`;
    const req = request(sig, {
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(now),
        "webhook-signature": sig,
      },
    });
    const handler = webhookRoute({ secretEnv: "HOOK_SECRET" }, () => ({ ok: true }));
    expect(await handler(req, ctx({ HOOK_SECRET: "s" }))).toEqual({ ok: true });
    expect(readRouteResponse(await handler(req, ctx({ HOOK_SECRET: "x" })))).toEqual({
      status: 401,
      body: { error: "Invalid webhook signature" },
    });
    expect(readRouteResponse(await handler(req, ctx({})))).toEqual({
      status: 500,
      body: { error: "HOOK_SECRET is not set" },
    });
  });
});
