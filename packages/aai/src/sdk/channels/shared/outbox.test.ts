// Copyright 2026 the AAI authors. MIT license.
// A published channel outbox takes every send instead of the network, and is
// never handed a credential.

import { afterEach, describe, expect, test, vi } from "vitest";
import { slackChannel } from "../slack.ts";
import { textbeltChannel } from "../textbelt.ts";
import { type ChannelOutbox, publishChannelOutbox, publishedChannelOutbox } from "./outbox.ts";
import { type ChannelFetch, postToChannel } from "./send.ts";

afterEach(() => publishChannelOutbox(undefined));

const textbelt = textbeltChannel({ key: "textbelt-test-key", to: "+15555550123" });
const SLACK_WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret-part";

function okFetch() {
  return vi.fn<ChannelFetch>(async () => new Response('{"success":true}', { status: 200 }));
}

describe("postToChannel with an outbox published", () => {
  test("hands the sink the send, answers ok, and never calls fetch", async () => {
    const sink = vi.fn<ChannelOutbox>();
    publishChannelOutbox(sink);
    const fetchFn = okFetch();
    await expect(postToChannel(textbelt, { text: "Your table is at 7." }, fetchFn)).resolves.toBe(
      "ok",
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith({
      kind: "textbelt",
      to: "+15555550123",
      body: { phone: "+15555550123", message: "Your table is at 7." },
    });
  });

  test("the Textbelt key never reaches the sink", async () => {
    const sink = vi.fn<ChannelOutbox>();
    publishChannelOutbox(sink);
    await postToChannel(textbelt, { text: "hi" }, okFetch());
    const [entry] = sink.mock.calls[0] ?? [];
    expect(entry?.body).not.toHaveProperty("key");
    expect(JSON.stringify(entry)).not.toContain("textbelt-test-key");
  });

  test("a Slack entry carries no URL (the webhook URL is the secret) and no `to`", async () => {
    const sink = vi.fn<ChannelOutbox>();
    publishChannelOutbox(sink);
    await postToChannel(slackChannel({ webhookUrl: SLACK_WEBHOOK }), { text: "done" }, okFetch());
    const [entry] = sink.mock.calls[0] ?? [];
    expect(entry).toMatchObject({ kind: "slack" });
    expect(entry).not.toHaveProperty("to");
    expect(JSON.stringify(entry)).not.toContain("secret-part");
  });

  test("a sink that rejects fails the send", async () => {
    publishChannelOutbox(async () => {
      throw new Error("disk full");
    });
    await expect(postToChannel(textbelt, { text: "hi" }, okFetch())).rejects.toThrow("disk full");
  });

  test("unpublishing restores the real post", async () => {
    publishChannelOutbox(vi.fn<ChannelOutbox>());
    publishChannelOutbox(undefined);
    expect(publishedChannelOutbox()).toBeUndefined();
    const fetchFn = okFetch();
    await postToChannel(textbelt, { text: "hi" }, fetchFn);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
