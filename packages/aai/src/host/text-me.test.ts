// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { setSessionPhone } from "../sdk/session-phone.ts";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
import { createTextMe } from "./text-me.ts";

const OWNER = "+15555550100";
const env = { TEXTBELT_KEY: "textbelt-test-key", SMS_TO_PHONE: OWNER };

function textbelt(answer: unknown = { success: true, textId: 1 }) {
  return vi.fn((_url: string, _init: RequestInit) => Promise.resolve(Response.json(answer)));
}

const sentBody = (mock: ReturnType<typeof textbelt>) =>
  JSON.parse(String(mock.mock.calls[0]?.[1].body)) as Record<string, string>;

describe("text_me", () => {
  test("texts the owner through Textbelt, and says only that it sent", async () => {
    const mockFetch = textbelt();
    const result = await createTextMe(fakeFetch(mockFetch)).execute(
      { message: "Turn left on Main St.", url: "https://maps.example.com/route" },
      createMockToolContext({ sessionId: "text-me-owner", env }),
    );
    expect(result).toEqual({ sent: true });
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://textbelt.com/text");
    expect(sentBody(mockFetch)).toEqual({
      phone: OWNER,
      message: "Turn left on Main St.\nhttps://maps.example.com/route",
      key: "textbelt-test-key",
    });
  });

  test("a client-reported number is used only when the owner listed it", async () => {
    const listed = textbelt();
    setSessionPhone("text-me-listed", "+15555550123");
    await createTextMe(fakeFetch(listed)).execute(
      { message: "hi" },
      createMockToolContext({
        sessionId: "text-me-listed",
        env: { ...env, SMS_ALLOWED_PHONES: "+1 (555) 555-0123" },
      }),
    );
    expect(sentBody(listed).phone).toBe("+15555550123");

    const unlisted = textbelt();
    setSessionPhone("text-me-unlisted", "+15555550199");
    await createTextMe(fakeFetch(unlisted)).execute(
      { message: "hi" },
      createMockToolContext({ sessionId: "text-me-unlisted", env }),
    );
    expect(sentBody(unlisted).phone).toBe(OWNER);
  });

  test("with no key, or nobody to text, it answers the model and sends nothing", async () => {
    const mockFetch = textbelt();
    const tool = createTextMe(fakeFetch(mockFetch));
    expect(
      await tool.execute(
        { message: "hi" },
        createMockToolContext({ env: { SMS_TO_PHONE: OWNER } }),
      ),
    ).toEqual({ error: expect.stringContaining("TEXTBELT_KEY") });
    expect(
      await tool.execute(
        { message: "hi" },
        createMockToolContext({ env: { TEXTBELT_KEY: "textbelt-test-key" } }),
      ),
    ).toEqual({ error: expect.stringContaining("SMS_TO_PHONE") });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("only an http(s) link is texted", async () => {
    const mockFetch = textbelt();
    const result = await createTextMe(fakeFetch(mockFetch)).execute(
      { message: "hi", url: "javascript:alert(1)" },
      createMockToolContext({ env }),
    );
    expect(result).toEqual({ error: "Only an http(s) link can be texted." });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a Textbelt refusal is the tool's result, not a throw, and names no number", async () => {
    const result = await createTextMe(
      fakeFetch(textbelt({ success: false, error: "Out of quota" })),
    ).execute({ message: "hi" }, createMockToolContext({ env }));
    expect(result).toEqual({ error: expect.stringContaining("Out of quota") });
    expect(JSON.stringify(result)).not.toContain(OWNER);
  });

  test("a refusal quoting the key back reaches the model with the key redacted", async () => {
    const error =
      "Sorry, ability to send URLs via text is limited to verified accounts. Please go to " +
      "https://textbelt.com/whitelist?key=textbelt-test-key or email support@textbelt.com.";
    const result = await createTextMe(fakeFetch(textbelt({ success: false, error }))).execute(
      { message: "hi", url: "https://maps.example.com/route" },
      createMockToolContext({ env }),
    );
    expect(result).toEqual({ error: expect.stringContaining("verified accounts") });
    expect(JSON.stringify(result)).not.toContain("textbelt-test-key");
    expect(JSON.stringify(result)).toContain("whitelist?key=[redacted]");
  });

  test("a request that never answers is a result too", async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const result = await createTextMe(fakeFetch(failing)).execute(
      { message: "hi" },
      createMockToolContext({ env }),
    );
    expect(result).toEqual({ error: expect.stringContaining("did not send") });
  });

  test("a long message is cut so the link still arrives whole", async () => {
    const mockFetch = textbelt();
    const url = "https://example.com/recipe";
    await createTextMe(fakeFetch(mockFetch)).execute(
      { message: "y".repeat(1000), url },
      createMockToolContext({ env }),
    );
    const message = sentBody(mockFetch).message ?? "";
    expect(message.endsWith(`…\n${url}`)).toBe(true);
    expect(message.length).toBeLessThanOrEqual(1000);
  });
});
