// Copyright 2026 the AAI authors. MIT license.
/**
 * The webhook handler's own reading of a payload.
 *
 * The route in front of it is unauthenticated, so the cap is a security
 * control and not a nicety — and it was measured in the wrong UNIT. A JS
 * string's `length` counts UTF-16 code units, so a body of two-byte characters
 * was charged half its real size and a three-byte one a third: the megabyte cap
 * admitted three megabytes of UTF-8. The cap counts bytes here, and the
 * boundary in front of it (`serveFetch`, `workflow-http-adapter.test.ts`) stops
 * the stream from ever reaching this function over-sized in the first place.
 */

import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { WORKFLOW_WEBHOOK_PREFIX } from "./workflow-serve.ts";
import { createWebhookHandler, MAX_WEBHOOK_BODY_BYTES, webhookToken } from "./workflow-webhook.ts";

const URL_FOR = (token: string) => `http://guest.local${WORKFLOW_WEBHOOK_PREFIX}${token}`;

function target(delivered = true) {
  return { signal: vi.fn(async () => delivered) };
}

function post(token: string, body?: string): Request {
  const init = body === undefined ? { method: "POST" } : { method: "POST", body };
  return new Request(URL_FOR(token), init);
}

describe("the payload cap counts BYTES", () => {
  test("a multi-byte body over the cap is refused even though its length is under it", async () => {
    // 600k two-byte characters: 600,000 UTF-16 code units (under the cap by the
    // old measure) and 1,200,000 bytes (over it by the real one).
    const body = "é".repeat(600_000);
    expect(body.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);

    const client = target();
    const handler = createWebhookHandler(() => client, silentLogger);
    const res = await handler("tok", post("tok", body));

    expect(res.status).toBe(413);
    // The point of the cap: nothing that big is delivered to a run.
    expect(client.signal).not.toHaveBeenCalled();
  });

  test("a body at the cap still delivers", async () => {
    const client = target();
    const handler = createWebhookHandler(() => client, silentLogger);
    const res = await handler("tok", post("tok", "a".repeat(MAX_WEBHOOK_BODY_BYTES)));

    expect(res.status).toBe(200);
    expect(client.signal).toHaveBeenCalledOnce();
  });
});

describe("what a payload becomes", () => {
  test("JSON is delivered parsed, anything else as the raw string, empty as undefined", async () => {
    const client = target();
    const handler = createWebhookHandler(() => client, silentLogger);

    await handler("tok", post("tok", '{"approved":true}'));
    await handler("tok", post("tok", "not json at all"));
    await handler("tok", post("tok"));

    expect(client.signal.mock.calls).toEqual([
      ["tok", { approved: true }],
      ["tok", "not json at all"],
      ["tok", undefined],
    ]);
  });

  test("a token nothing is listening on is a 404, never a 5xx", async () => {
    const client = target(false);
    const handler = createWebhookHandler(() => client, silentLogger);
    const res = await handler("gone", post("gone", "{}"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No workflow hook for this token" });
  });
});

describe("webhookToken", () => {
  test("reads the single trailing segment and nothing else", () => {
    expect(webhookToken(`${WORKFLOW_WEBHOOK_PREFIX}abc`)).toBe("abc");
    expect(webhookToken(`${WORKFLOW_WEBHOOK_PREFIX}`)).toBeUndefined();
    expect(webhookToken(`${WORKFLOW_WEBHOOK_PREFIX}a/b`)).toBeUndefined();
    expect(webhookToken("/elsewhere")).toBeUndefined();
  });
});
