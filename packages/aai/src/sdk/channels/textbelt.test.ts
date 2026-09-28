// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { sendToChannelOrFail } from "../step-errors.ts";
import { installStubStepFetch } from "../testing-vitest.ts";
import { ChannelDeliveryError } from "./shared/channel-types.ts";
import { explainChannelFailure, renderChannelPayload, sendToChannel } from "./shared/send.ts";
import {
  renderTextbeltText,
  TEXTBELT_MAX_MESSAGE_CHARS,
  textbeltChannel,
  textbeltRefusal,
} from "./textbelt.ts";

const channel = textbeltChannel({ key: "textbelt-test-key", to: "+15555550123" });

describe("textbeltChannel", () => {
  test("renders Textbelt's body, with the recipient fixed by the descriptor", () => {
    expect(renderChannelPayload(channel, { text: "Your table is at 7." })).toEqual({
      url: "https://textbelt.com/text",
      body: { phone: "+15555550123", message: "Your table is at 7.", key: "textbelt-test-key" },
    });
  });

  test("folds a structured message into one plain text", () => {
    const text = renderTextbeltText({
      text: "Pancakes",
      heading: "Pancakes (serves 4)",
      sections: [
        { title: "You need", bullets: ["2 eggs", "1 cup flour"] },
        { url: "https://example.com/pancakes" },
      ],
    });
    expect(text).toBe(
      "Pancakes (serves 4)\n\nYou need\n- 2 eggs\n- 1 cup flour\n\nhttps://example.com/pancakes",
    );
  });

  test("cuts a long text at the cap, with an ellipsis, rather than splitting it", () => {
    const text = renderTextbeltText({ text: "x".repeat(TEXTBELT_MAX_MESSAGE_CHARS + 50) });
    expect(text).toHaveLength(TEXTBELT_MAX_MESSAGE_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });

  test("refuses a descriptor missing its key or recipient, naming the field", () => {
    expect(() =>
      renderChannelPayload({ kind: "textbelt", options: { to: "+15555550123" } }, { text: "x" }),
    ).toThrow(/needs a string `key`/);
    expect(() =>
      renderChannelPayload({ kind: "textbelt", options: { key: "k", to: " " } }, { text: "x" }),
    ).toThrow(/needs a string `to`/);
  });
});

describe("a Textbelt answer", () => {
  test.each([
    ['{"success":true,"quotaRemaining":40,"textId":12345}', undefined],
    ['{"success":false,"quotaRemaining":0,"error":"Out of quota"}', "Out of quota"],
    ['{"success":false}', "Textbelt did not confirm the send"],
    ["not json", "Textbelt's answer was not JSON"],
  ])("%s reads as %s", (body, reason) => {
    expect(textbeltRefusal(body)).toBe(reason);
  });

  test("advice names the fix and never the number or the key", () => {
    for (const detail of ["Out of quota", "Sending URLs requires whitelisting", "Invalid phone"]) {
      const advice = explainChannelFailure(channel, detail);
      expect.soft(advice).not.toContain("+15555550123");
      expect.soft(advice).not.toContain("textbelt-test-key");
    }
    expect(explainChannelFailure(channel, "Out of quota")).toMatch(/top it up/);
    expect(explainChannelFailure(channel, "URL not allowed")).toContain("textbelt.com/whitelist");
  });
});

describe("posting to Textbelt", () => {
  test("a success answer is delivered", async () => {
    const fetched = installStubStepFetch(() => ({ body: { success: true, textId: 1 } }));
    expect(await sendToChannel(channel, { text: "hi" })).toContain('"success":true');
    expect(fetched.calls[0]?.url).toBe("https://textbelt.com/text");
    expect(JSON.parse(String(fetched.calls[0]?.body))).toEqual({
      phone: "+15555550123",
      message: "hi",
      key: "textbelt-test-key",
    });
  });

  test("a 200 that says success:false is a terminal refusal, not a delivery", async () => {
    installStubStepFetch(() => ({ body: { success: false, error: "Out of quota" } }));
    const err = await sendToChannel(channel, { text: "hi" }).catch((thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(ChannelDeliveryError);
    expect(err).toMatchObject({ channelKind: "textbelt", status: 200, retryable: false });
    expect((err as Error).message).toContain("Out of quota");
  });

  test("a 5xx stays retryable, as on every channel", async () => {
    installStubStepFetch(() => ({ status: 503, body: "busy" }));
    await expect(sendToChannel(channel, { text: "hi" })).rejects.toMatchObject({
      retryable: true,
    });
  });

  test("sendToChannelOrFail makes the refusal a step's fatal error", async () => {
    installStubStepFetch(() => ({ body: { success: false, error: "Invalid phone number" } }));
    await expect(sendToChannelOrFail(channel, { text: "hi" })).rejects.toThrow(/recipient/);
  });
});
