// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { type StubStepFetch, stubStepFetch } from "./_testing-step-fetch.ts";
import { publishStepEnv } from "./step-env.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import { stepTextOwner } from "./step-text-owner.ts";

// Fictional values throughout: 555-01xx numbers, a made-up key.
const OWNER = "+15555550100";
const LISTED = "+15555550123";
const env = { TEXTBELT_KEY: "tb-key-test", SMS_TO_PHONE: OWNER, SMS_ALLOWED_PHONES: LISTED };

let textbelt: StubStepFetch | undefined;
afterEach(() => {
  textbelt?.restore();
  textbelt = undefined;
  publishStepEnv(undefined);
});

function sentBody(): { phone?: string; message?: string; key?: string } {
  return JSON.parse(String(textbelt?.calls[0]?.body));
}

describe("stepTextOwner", () => {
  test("texts the owner and answers who it went to", async () => {
    publishStepEnv(env);
    textbelt = stubStepFetch(() => ({ status: 200, body: { success: true } }));
    expect(await stepTextOwner("Your report is ready.")).toEqual({ sent: true, to: OWNER });
    expect(textbelt.calls[0]?.url).toBe("https://textbelt.com/text");
    expect(sentBody()).toMatchObject({
      phone: OWNER,
      message: "Your report is ready.",
      key: "tb-key-test",
    });
  });

  test("a claimed number is used only when the owner listed it", async () => {
    publishStepEnv(env);
    textbelt = stubStepFetch(() => ({ status: 200, body: { success: true } }));
    expect(await stepTextOwner("hi", { phone: "+1 (555) 555-0123" })).toEqual({
      sent: true,
      to: LISTED,
    });
    expect(await stepTextOwner("hi", { phone: "+15555550199" })).toEqual({
      sent: true,
      to: OWNER,
    });
  });

  test("no recipient configured is not sent, with no reason — and no request", async () => {
    publishStepEnv({ TEXTBELT_KEY: "tb-key-test" });
    textbelt = stubStepFetch(() => ({ status: 200, body: { success: true } }));
    expect(await stepTextOwner("hi", { phone: LISTED })).toEqual({ sent: false });
    expect(textbelt.calls).toHaveLength(0);
  });

  test("a recipient but no key is FATAL, naming the key", async () => {
    publishStepEnv({ SMS_TO_PHONE: OWNER });
    const err = await stepTextOwner("hi").catch((e: unknown) => e);
    expect(err).toSatisfy(FatalError.is);
    expect(String(err)).toContain("TEXTBELT_KEY");
  });

  test("a refusal that will refuse again is an answer with a reason", async () => {
    publishStepEnv(env);
    textbelt = stubStepFetch(() => ({
      status: 200,
      body: { success: false, error: "Out of quota" },
    }));
    const result = await stepTextOwner("hi");
    expect(result.sent).toBe(false);
    expect(result).toHaveProperty("why", expect.stringContaining("Out of quota"));
  });

  test("a transient failure is thrown, retryable", async () => {
    publishStepEnv(env);
    textbelt = stubStepFetch(() => ({ status: 503, body: { error: "busy" } }));
    const err = await stepTextOwner("hi").catch((e: unknown) => e);
    expect(err).toSatisfy(RetryableError.is);
  });

  test("links follow TEXTBELT_LINKS unless the call says otherwise", async () => {
    publishStepEnv({ ...env, TEXTBELT_LINKS: " Strip " });
    textbelt = stubStepFetch(() => ({ status: 200, body: { success: true } }));
    await stepTextOwner("See https://example.test/report for more.");
    expect(sentBody().message).toBe("See for more.");
    await stepTextOwner("See https://example.test/report", { links: "keep" });
    expect(JSON.parse(String(textbelt.calls[1]?.body)).message).toBe(
      "See https://example.test/report",
    );
  });

  test("a text that is only links, on a key that strips them, is not sent", async () => {
    publishStepEnv(env);
    textbelt = stubStepFetch(() => ({ status: 200, body: { success: true } }));
    const result = await stepTextOwner("https://example.test/a", { links: "strip" });
    expect(result).toEqual({
      sent: false,
      why: "the text was only links, and this Textbelt key can't send links yet",
    });
    expect(textbelt.calls).toHaveLength(0);
  });
});
