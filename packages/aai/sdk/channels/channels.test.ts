// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import type { StubStepAnswer } from "../testing.ts";
import { installStubStepFetch } from "../testing-vitest.ts";
import { ChannelDeliveryError } from "./channel-types.ts";
import {
  CHANNEL_POST_TIMEOUT_MS,
  channelAdvice,
  renderChannelPayload,
  sendToChannel,
} from "./send.ts";
import {
  escapeSlackMrkdwn,
  isSlackWebhookUrl,
  isSlackWorkflowTriggerUrl,
  renderSlackPlainText,
  slackChannel,
} from "./slack.ts";

const MESSAGE = {
  text: "Digest 1/2: 1 episode summaries",
  heading: "Digest 1/2",
  subtitle: "Feeds: example.test",
  sections: [
    {
      title: "Example Episode",
      url: "https://example.test/ep",
      subtitle: "Example Podcast",
      body: "A concise summary.",
      bullets: ["First point", "Second point"],
    },
  ],
};

const INCOMING = "https://hooks.slack.com/services/T/B/a";
const TRIGGER = "https://hooks.slack.com/triggers/T/B/a";

describe("recognising a Slack destination", () => {
  test.each([
    [TRIGGER, true],
    [INCOMING, false],
    ["https://example.com/triggers/T/B/a", false],
    ["not a url", false],
  ])("isSlackWorkflowTriggerUrl(%s) === %s", (url, expected) => {
    expect(isSlackWorkflowTriggerUrl(url)).toBe(expected);
  });

  test.each([
    ["an incoming webhook", INCOMING, true],
    ["a workflow trigger", TRIGGER, true],
    ["the gov host", "https://hooks.slack-gov.com/services/T/B/a", true],
    // The security half: this value becomes the target of a POST carrying
    // whatever the run summarized, so a host check is what stops a form field
    // becoming an exfiltration endpoint.
    ["a lookalike host", "https://hooks.slack.com.evil.test/services/a", false],
    ["a non-Slack host", "https://example.com/services/T/B/a", false],
    ["plain http", "http://hooks.slack.com/services/T/B/a", false],
    ["no path", "https://hooks.slack.com", false],
    ["not a url at all", "hooks.slack.com/services", false],
  ])("isSlackWebhookUrl accepts %s: %s", (_label, url, expected) => {
    expect(isSlackWebhookUrl(url)).toBe(expected);
  });
});

describe("rendering, which is where the two webhook shapes diverge", () => {
  /** The distinction the module exists for — the two URLs take different bodies. */
  test("sends Block Kit to an incoming webhook", () => {
    const { url, body } = renderChannelPayload(slackChannel({ webhookUrl: INCOMING }), MESSAGE);

    expect(url).toBe(INCOMING);
    expect(body).toHaveProperty("blocks");
    // Without `text`, Slack notifies as "[no preview]".
    expect(body.text).toBe(MESSAGE.text);
  });

  test("sends flat variables to a workflow trigger, under the configured name", () => {
    const channel = slackChannel({ webhookUrl: TRIGGER, textParam: "digest_body" });
    const { body } = renderChannelPayload(channel, MESSAGE);

    expect(Object.keys(body)).toEqual(["digest_body"]);
    expect(body).not.toHaveProperty("blocks");
    expect(String(body.digest_body)).toContain("Digest 1/2");
  });

  test("defaults the trigger variable to the name Slack's own example uses", () => {
    const { body } = renderChannelPayload(slackChannel({ webhookUrl: TRIGGER }), MESSAGE);
    expect(Object.keys(body)).toEqual(["text"]);
  });

  test("a trigger body carries every section's prose and bullets", () => {
    const text = renderSlackPlainText(MESSAGE);

    expect(text).toContain("Example Episode — Example Podcast");
    expect(text).toContain("https://example.test/ep");
    expect(text).toContain("A concise summary.");
    expect(text).toContain("- First point");
  });

  test("links a section's title when it carries a url, and does not when it does not", () => {
    const linked = renderChannelPayload(slackChannel({ webhookUrl: INCOMING }), {
      text: "t",
      sections: [{ title: "Linked", url: "https://example.test/x" }, { title: "Bare" }],
    });
    const rendered = JSON.stringify(linked.body);

    expect(rendered).toContain("*<https://example.test/x|Linked>*");
    expect(rendered).toContain("*Bare*");
  });

  /**
   * A `header` block's `plain_text` is capped at 150 characters and a longer
   * one is a 400 on the WHOLE payload — so a long heading must be truncated
   * rather than passed through.
   */
  test("truncates a heading past Slack's header cap", () => {
    const { body } = renderChannelPayload(slackChannel({ webhookUrl: INCOMING }), {
      text: "t",
      heading: "H".repeat(200),
    });
    const header = (body.blocks as { text?: { text?: string } }[])[0]?.text?.text ?? "";

    expect(header).toHaveLength(150);
    expect(header.endsWith("…")).toBe(true);
  });

  /**
   * `plain_text` is not mrkdwn: Slack renders the reserved characters
   * literally there, so escaping the header would print "&amp;" to a reader.
   */
  test("escapes mrkdwn sections and leaves the plain-text header alone", () => {
    const { body } = renderChannelPayload(slackChannel({ webhookUrl: INCOMING }), {
      text: "t",
      heading: "Tom & Jerry",
      sections: [{ body: "Tom & Jerry <b>" }],
    });
    const blocks = body.blocks as { text?: { text?: string } }[];

    expect(blocks[0]?.text?.text).toBe("Tom & Jerry");
    expect(JSON.stringify(blocks)).toContain("Tom &amp; Jerry &lt;b&gt;");
  });

  test("escapes only Slack's three reserved characters, ampersand first", () => {
    expect(escapeSlackMrkdwn("Tom & Jerry <b>")).toBe("Tom &amp; Jerry &lt;b&gt;");
    // Apostrophes are not reserved — escaping them would litter every summary.
    expect(escapeSlackMrkdwn("it's fine")).toBe("it's fine");
  });

  test("renders a message carrying nothing but its notification line", () => {
    const { body } = renderChannelPayload(slackChannel({ webhookUrl: INCOMING }), {
      text: "Run finished.",
    });

    expect(body.text).toBe("Run finished.");
    expect(renderSlackPlainText({ text: "Run finished." })).toBe("Run finished.");
  });
});

describe("the advice a refusal deserves", () => {
  test("names the unpublished-workflow case, which no generic message explains", () => {
    const advice = channelAdvice(slackChannel({ webhookUrl: TRIGGER }), "workflow_not_published");
    expect(advice).toContain("not published");
  });

  test("points a trigger caller at the variable name", () => {
    const advice = channelAdvice(slackChannel({ webhookUrl: TRIGGER }), "invalid_arguments");
    expect(advice).toContain("text parameter");
  });

  test("tells an incoming-webhook caller to check the webhook, not the workflow", () => {
    const advice = channelAdvice(slackChannel({ webhookUrl: INCOMING }), "invalid_payload");
    expect(advice).toContain("revoked");
    expect(advice).not.toContain("workflow");
  });
});

describe("posting", () => {
  const stub = (answer: StubStepAnswer) => installStubStepFetch(() => answer);

  test("posts the rendered payload and answers with what the platform said", async () => {
    const fetched = stub({ body: "ok" });

    expect(await sendToChannel(slackChannel({ webhookUrl: INCOMING }), MESSAGE)).toBe("ok");
    expect(fetched.calls[0]?.method).toBe("POST");
    expect(fetched.calls[0]?.url).toBe(INCOMING);
    expect(fetched.calls[0]?.headers?.["Content-Type"]).toBe("application/json");
    expect(String(fetched.calls[0]?.body)).toContain("Digest 1/2");
  });

  test("treats an empty 200 as success rather than an empty status", async () => {
    stub({ body: "" });
    expect(await sendToChannel(slackChannel({ webhookUrl: INCOMING }), MESSAGE)).toBe("ok");
  });

  /**
   * The 4xx/5xx split is the reason this is not a one-line `stepFetchOk`: a
   * revoked webhook answers 4xx identically on every retry, so retrying it
   * burns the step's attempts and delays the real error by minutes.
   */
  test("makes a 4xx terminal, with advice a person can act on", async () => {
    stub({ status: 403, body: { error: "invalid_token" } });

    const err = await sendToChannel(slackChannel({ webhookUrl: INCOMING }), MESSAGE).catch(
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(ChannelDeliveryError);
    expect(err).toMatchObject({ retryable: false, status: 403, channelKind: "slack" });
    expect((err as Error).message).toMatch(/revoked/);
    // The BODY is what chose the sentence, so it has to reach the error.
    expect((err as Error).message).toContain("invalid_token");
  });

  test("leaves a 5xx retryable, because that is the platform having a bad minute", async () => {
    stub({ status: 503, body: "busy" });

    const err = await sendToChannel(slackChannel({ webhookUrl: INCOMING }), MESSAGE).catch(
      (thrown: unknown) => thrown,
    );

    expect(err).toMatchObject({ retryable: true, status: 503 });
    expect((err as Error).message).toContain("503");
  });

  test("carries a Retry-After the platform named, so a retry waits what was asked", async () => {
    stub({ status: 429, body: "slow down", headers: { "retry-after": "42" } });

    const err = await sendToChannel(slackChannel({ webhookUrl: INCOMING }), MESSAGE).catch(
      (thrown: unknown) => thrown,
    );

    expect((err as ChannelDeliveryError).retryable).toBe(true);
    expect((err as ChannelDeliveryError).retryAfter).toBeInstanceOf(Date);
  });

  /**
   * The SHIPPED budget, pinned. `StubStepRequest` does not record the signal,
   * so this asserts the number the post is bounded by rather than the bounding
   * — which is the half that would change silently.
   */
  test("bounds the post at 30s, so a step cannot hold a socket open forever", () => {
    expect(CHANNEL_POST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("a descriptor that is not one", () => {
  /**
   * A channel descriptor round-trips through a durable run's journal, so what
   * arrives here is whatever was written there — a `kind` nothing serves has
   * to be a throw rather than a delivery that quietly did not happen.
   */
  test("refuses an unknown kind, naming what it does know", () => {
    expect(() => renderChannelPayload({ kind: "carrier-pigeon", options: {} }, MESSAGE)).toThrow(
      /Unknown channel kind "carrier-pigeon".*slack/s,
    );
  });

  test("refuses a Slack descriptor with no webhook url", () => {
    expect(() => renderChannelPayload({ kind: "slack", options: {} }, MESSAGE)).toThrow(
      /needs a string `webhookUrl`/,
    );
  });
});
