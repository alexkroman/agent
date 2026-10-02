// Copyright 2026 the AAI authors. MIT license.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RouteContext, RouteRequest } from "./agent-routes.ts";
import { readRouteResponse } from "./agent-routes.ts";
import { COMPOSIO_BASE_URL } from "./composio-api.ts";
import {
  type ComposioTriggerEvent,
  composioTriggerText,
  composioWebhookRoute,
  ensureComposioWebhook,
} from "./composio-webhook.ts";
import { type StubFetchRoutes, stubFetchRoutes } from "./testing-fetch-routes.ts";
import { createStubWorkflows } from "./testing-workflows.ts";

const SECRET = "composio-secret";

function delivery(body: unknown, secret = SECRET): RouteRequest {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`msg_1.${ts}.${raw}`).digest("base64");
  return {
    method: "POST",
    path: "/composio/webhook",
    params: {},
    query: {},
    headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
    body,
    rawBody: raw,
  };
}

const ctx = (env: Record<string, string> = { COMPOSIO_WEBHOOK_SECRET: SECRET }): RouteContext => ({
  env,
  workflows: createStubWorkflows(),
  clientTranscript: async () => ({ sessions: [] }),
  speech: () => undefined,
  signal: new AbortController().signal,
});

const EVENT: ComposioTriggerEvent = {
  id: "evt_1",
  type: "composio.trigger.message",
  metadata: { trigger_id: "ti_1", user_id: "u1" },
  data: { subject: "Hi" },
};

describe("composioWebhookRoute", () => {
  test("a verified trigger event reaches the handler, whose answer is the response", async () => {
    const seen: ComposioTriggerEvent[] = [];
    const route = composioWebhookRoute({}, (event) => {
      seen.push(event);
      return { started: true };
    });
    expect(await route(delivery(EVENT), ctx())).toEqual({ started: true });
    expect(seen).toEqual([EVENT]);
  });

  test("another event type is acknowledged without calling the handler", async () => {
    const handler = vi.fn();
    const route = composioWebhookRoute({}, handler);
    const out = await route(
      delivery({ id: "e", type: "composio.connected_account.expired" }),
      ctx(),
    );
    expect(out).toEqual({ ignored: "composio.connected_account.expired" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a bad signature, an unset secret and a non-event body never reach the handler", async () => {
    const handler = vi.fn();
    const route = composioWebhookRoute({ secretEnv: "HOOK" }, handler);
    expect(readRouteResponse(await route(delivery(EVENT, "wrong"), ctx({ HOOK: SECRET })))).toEqual(
      { status: 401, body: { error: "Invalid webhook signature" } },
    );
    expect(readRouteResponse(await route(delivery(EVENT), ctx({})))).toEqual({
      status: 500,
      body: { error: "HOOK is not set" },
    });
    expect(readRouteResponse(await route(delivery([1, 2]), ctx({ HOOK: SECRET })))).toEqual({
      status: 400,
      body: { error: "Not a Composio event" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("composioTriggerText", () => {
  test("compact JSON, empty fields dropped, bounded", () => {
    expect(composioTriggerText({ a: "x", b: "", c: null }, { maxChars: 100 })).toBe('{"a":"x"}');
    expect(composioTriggerText(undefined, { maxChars: 100 })).toBe("{}");
    const big = composioTriggerText({ body: "y".repeat(5000) }, { maxChars: 300 });
    expect(big.length).toBeLessThanOrEqual(300);
  });
});

describe("ensureComposioWebhook", () => {
  const HOST = new URL(COMPOSIO_BASE_URL).host;
  let net: StubFetchRoutes | undefined;
  afterEach(() => net?.restore());
  const env = { env: { COMPOSIO_API_KEY: "k" } };
  const want = {
    webhook_url: "https://agent.test/api/composio/webhook",
    enabled_events: ["composio.trigger.message"],
    version: "V3",
  };

  test("creates the subscription when there is none", async () => {
    net = stubFetchRoutes({
      [`GET ${HOST}`]: { body: { items: [] } },
      [`POST ${HOST}`]: { status: 201, body: { id: "ws_1", secret: "s1" } },
    });
    expect(await ensureComposioWebhook(env, want.webhook_url)).toEqual({
      id: "ws_1",
      secret: "s1",
    });
    expect(net.to(`POST ${HOST}`)[0]?.json).toEqual(want);
  });

  test("moves the existing one", async () => {
    net = stubFetchRoutes({
      [`GET ${HOST}`]: { body: { items: [{ id: "ws_9" }] } },
      [`PATCH ${HOST}`]: { body: { id: "ws_9", secret: "s9" } },
    });
    expect(await ensureComposioWebhook(env, want.webhook_url)).toEqual({
      id: "ws_9",
      secret: "s9",
    });
    const patch = net.to(`PATCH ${HOST}`)[0];
    expect(patch?.pathname).toMatch(/\/webhook_subscriptions\/ws_9$/);
    expect(patch?.json).toEqual(want);
  });

  test("refuses a non-https URL", async () => {
    await expect(ensureComposioWebhook(env, "http://agent.test/hook")).rejects.toThrow(/https/);
  });
});
