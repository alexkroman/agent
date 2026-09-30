// Copyright 2026 the AAI authors. MIT license.
// A channel refusal never carries a credential: whatever the platform wrote
// back is redacted before it becomes a `ChannelDeliveryError`'s message, which
// is stored with the run, logged and shown.

import { describe, expect, test, vi } from "vitest";
import { slackChannel } from "../slack.ts";
import { textbeltChannel } from "../textbelt.ts";
import { ChannelDeliveryError } from "./channel-types.ts";
import { redactChannelCredentials } from "./outbox.ts";
import { type ChannelFetch, postToChannel, registerChannelHandler } from "./send.ts";

const FAKE_KEY = "fakekey0123456789abcdef";
const textbelt = textbeltChannel({ key: FAKE_KEY, to: "+15555550123" });
const SLACK_WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret-part";
const slack = slackChannel({ webhookUrl: SLACK_WEBHOOK });

/** The refusal Textbelt really sent, key and all, for a text with a link. */
const WHITELIST_REFUSAL = {
  success: false,
  error:
    "Sorry, ability to send URLs via text is limited to verified accounts. Please go to " +
    `https://textbelt.com/whitelist?key=${FAKE_KEY} or email support@textbelt.com to verify your account.`,
};

function answering(body: string, status = 200) {
  return vi.fn<ChannelFetch>(async () => new Response(body, { status }));
}

async function refusal(promise: Promise<unknown>): Promise<ChannelDeliveryError> {
  const err = await promise.catch((thrown: unknown) => thrown);
  if (err instanceof ChannelDeliveryError) return err;
  throw new Error(`expected a ChannelDeliveryError, got ${String(err)}`);
}

describe("a refusal that quotes the credential back", () => {
  test("Textbelt's whitelist refusal keeps the hint and loses the key", async () => {
    const err = await refusal(
      postToChannel(textbelt, { text: "hi" }, answering(JSON.stringify(WHITELIST_REFUSAL))),
    );
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toMatch(/key=(?!\[redacted\])/);
    expect(err.message).toContain("limited to verified accounts");
    expect(err.message).toContain("https://textbelt.com/whitelist?key=[redacted]");
    expect(err).toMatchObject({ status: 200, retryable: false });
  });

  test("a 4xx body echoing the key is redacted, JSON error or raw preview", async () => {
    for (const body of [
      JSON.stringify({ error: `Invalid key ${FAKE_KEY}` }),
      `<html>bad key: ${FAKE_KEY}</html>`,
      `bad key: ${encodeURIComponent(`${FAKE_KEY}/+`)}`,
    ]) {
      const err = await refusal(postToChannel(textbelt, { text: "hi" }, answering(body, 401)));
      expect.soft(err.message).not.toContain(FAKE_KEY);
      expect.soft(err.message).toContain("[redacted]");
    }
  });

  test("a 5xx preview is redacted too", async () => {
    const err = await refusal(
      postToChannel(textbelt, { text: "hi" }, answering(`upstream saw key ${FAKE_KEY}`, 502)),
    );
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(FAKE_KEY);
  });

  test("a Slack refusal never contains the webhook URL", async () => {
    const err = await refusal(
      postToChannel(
        slack,
        { text: "done" },
        answering(JSON.stringify({ error: `no_service for ${SLACK_WEBHOOK}` }), 404),
      ),
    );
    expect(err.message).not.toContain(SLACK_WEBHOOK);
    expect(err.message).not.toContain("secret-part");
    expect(err.message).toContain("no_service");
  });

  test("a fetch failure naming the webhook URL is rethrown redacted", async () => {
    const fetchFn = vi.fn<ChannelFetch>(async () => {
      throw new TypeError(`request to ${SLACK_WEBHOOK} failed`);
    });
    const err = await postToChannel(slack, { text: "done" }, fetchFn).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("secret-part");
  });
});

describe("redactChannelCredentials", () => {
  test("scrubs a secret-named query parameter no option names", () => {
    const text = "see https://x.test/a?token=abc&page=2 and https://x.test/b?api_key=zzz#top";
    expect(redactChannelCredentials(textbelt, ["key"], text)).toBe(
      "see https://x.test/a?token=[redacted]&page=2 and https://x.test/b?api_key=[redacted]#top",
    );
  });

  test("leaves a detail with no credential in it alone", () => {
    expect(redactChannelCredentials(textbelt, ["key"], "Out of quota")).toBe("Out of quota");
  });
});

describe("a registration's refusal and credential fields", () => {
  const handler = {
    kind: "test-refusing",
    render: (message: { text: string }, options: Record<string, unknown>) => ({
      url: "https://refuse.test/post",
      body: { text: message.text, secret: options.secret },
    }),
    advice: (_options: Record<string, unknown>, detail: string) => `refused: ${detail}`,
  };
  const channel = { kind: "test-refusing", options: { secret: "s3cr3t-value" } };

  test("a declared 2xx refusal throws, redacting the declared secret", async () => {
    registerChannelHandler(handler, {
      refusal: (body) => (body.startsWith("NO") ? body : undefined),
      credentialFields: ["secret"],
    });
    const err = await refusal(
      postToChannel(channel, { text: "hi" }, answering("NO: bad s3cr3t-value")),
    );
    expect(err.message).toBe("refused: NO: bad [redacted] (HTTP 200)");
    await expect(postToChannel(channel, { text: "hi" }, answering("fine"))).resolves.toBe("fine");
  });

  test("without a refusal reader every 2xx is a delivery", async () => {
    registerChannelHandler(handler);
    await expect(postToChannel(channel, { text: "hi" }, answering("NO"))).resolves.toBe("NO");
  });
});
