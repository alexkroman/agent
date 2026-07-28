// Copyright 2026 the AAI authors. MIT license.
// Send-channel specs: the slack() descriptor, openSender resolution, wire
// shape of the webhook POST, and the secrecy rule that the webhook URL (it
// embeds the credential) never appears in error messages.

import { describe, expect, test, vi } from "vitest";
import { openSender, sendAllowedHosts } from "./open.ts";
import { SLACK_WEBHOOK_HOST, SLACK_WEBHOOK_URL_ENV, slack } from "./slack.ts";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/secret-token";
const ENV = { [SLACK_WEBHOOK_URL_ENV]: WEBHOOK_URL };

type FetchMock = typeof globalThis.fetch & {
  mock: { calls: [input: string | URL | Request, init?: RequestInit][] };
};

function fetchMock(response: () => Response): FetchMock {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    response(),
  ) as unknown as FetchMock;
}

const okFetch = () => fetchMock(() => new Response("ok", { status: 200 }));

describe("slack() descriptor", () => {
  test("is pure data with the slack kind", () => {
    expect(slack()).toEqual({ kind: "slack", options: {} });
  });
});

describe("openSender — slack", () => {
  test("posts a string message as { text } JSON to the webhook URL", async () => {
    const fetchFn = okFetch();
    await openSender(slack(), ENV, { fetch: fetchFn }).send("hello team");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ text: "hello team" });
  });

  test("posts an object message verbatim (caller controls the body)", async () => {
    const fetchFn = okFetch();
    const blocks = { blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }] };
    await openSender(slack(), ENV, { fetch: fetchFn }).send(blocks);
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual(blocks);
  });

  test("forwards the abort signal", async () => {
    const fetchFn = okFetch();
    const controller = new AbortController();
    await openSender(slack(), ENV, { fetch: fetchFn }).send("x", { signal: controller.signal });
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.signal).toBe(controller.signal);
  });

  test("rejects when the webhook URL env is missing, naming the env var", async () => {
    const fetchFn = okFetch();
    const sender = openSender(slack(), {}, { fetch: fetchFn });
    await expect(sender.send("x")).rejects.toThrow(SLACK_WEBHOOK_URL_ENV);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("rejects on non-2xx with status and Slack's error body", async () => {
    const fetchFn = fetchMock(() => new Response("invalid_payload", { status: 400 }));
    const sender = openSender(slack(), ENV, { fetch: fetchFn });
    await expect(sender.send("x")).rejects.toThrow(/HTTP 400.*invalid_payload/);
  });

  test("error messages never contain the webhook URL (it embeds the credential)", async () => {
    const fetchFn = fetchMock(() => new Response("no_service", { status: 404 }));
    const sender = openSender(slack(), ENV, { fetch: fetchFn });
    const err = await sender.send("x").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain("hooks.slack.com");
    expect(err?.message).not.toContain("secret-token");
  });

  test("sender name reports the provider kind", () => {
    expect(openSender(slack(), ENV).name).toBe("slack");
  });
});

describe("openSender — unknown kind", () => {
  test("throws listing the supported kinds", () => {
    expect(() => openSender({ kind: "carrier-pigeon", options: {} }, {})).toThrow(
      /Unknown send provider kind.*slack/,
    );
  });
});

describe("sendAllowedHosts", () => {
  test("slack posts to hooks.slack.com", () => {
    expect(sendAllowedHosts(slack())).toEqual([SLACK_WEBHOOK_HOST]);
  });

  test("no descriptor, no hosts", () => {
    expect(sendAllowedHosts(undefined)).toEqual([]);
  });

  test("unknown kinds contribute no hosts", () => {
    expect(sendAllowedHosts({ kind: "x", options: {} })).toEqual([]);
  });
});
