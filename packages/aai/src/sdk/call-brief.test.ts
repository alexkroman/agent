// Copyright 2026 the AAI authors. MIT license.
/**
 * The brief's wire shape and its signature: what `stepPlaceCall({ brief })`
 * puts on the call, and what `readCallBrief(call, secret)` accepts back.
 */

import { describe, expect, test } from "vitest";
import {
  CALL_BRIEF_CHUNK_CHARS,
  isCallBriefParameter,
  MAX_CALL_BRIEF_PROMPT_CHARS,
  readCallBrief,
  signCallBrief,
} from "./call-brief.ts";
import { callParametersFromQuery, phoneWebhookUrl } from "./phone-webhook.ts";

/** The parameters as the answering session receives them: through the webhook URL's query. */
function overTheWire(parameters: Record<string, string>): Record<string, string> {
  const url = new URL(phoneWebhookUrl("https://agent.test", "twilio", parameters));
  return callParametersFromQuery(url.searchParams);
}

const SECRET = "shared-secret-7c1a";
const BRIEF = { id: "call_42", prompt: "Book a table for two at seven." };

describe("signCallBrief", () => {
  test("carries the id as `call`, a hex HMAC as `sig`, and the prompt as p0…pN", async () => {
    const params = await signCallBrief(BRIEF, SECRET);
    expect(params.call).toBe("call_42");
    expect(params.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(params.p0).toBe(BRIEF.prompt);
    expect(params.p1).toBeUndefined();
  });

  test("cuts a long prompt into chunks a Twilio <Parameter> fits", async () => {
    const prompt = "x".repeat(CALL_BRIEF_CHUNK_CHARS * 2 + 5);
    const params = await signCallBrief({ id: "call_1", prompt }, SECRET);
    expect(params.p0).toHaveLength(CALL_BRIEF_CHUNK_CHARS);
    expect(params.p1).toHaveLength(CALL_BRIEF_CHUNK_CHARS);
    expect(params.p2).toHaveLength(5);
    expect(params.p3).toBeUndefined();
    // Every chunk's name plus value is under Twilio's 500.
    for (const [name, value] of Object.entries(params)) {
      expect(name.length + value.length).toBeLessThan(500);
    }
  });

  test("never splits a surrogate pair across chunks, and keeps every chunk within the cap", async () => {
    // An emoji straddling the first boundary: cut by code unit, its halves
    // would land in p0 and p1, and `URLSearchParams` would write each lone
    // half as U+FFFD — a prompt that no longer matches its signature.
    const prompt = `${"a".repeat(CALL_BRIEF_CHUNK_CHARS - 1)}😀${"b".repeat(10)}`;
    const params = await signCallBrief({ id: "call_1", prompt }, SECRET);
    expect(params.p0).toBe("a".repeat(CALL_BRIEF_CHUNK_CHARS - 1));
    expect(params.p1).toBe(`😀${"b".repeat(10)}`);
    for (const [name, value] of Object.entries(params)) {
      expect(value.length).toBeLessThanOrEqual(CALL_BRIEF_CHUNK_CHARS);
      expect(name.length + value.length).toBeLessThan(500);
    }
    expect(await readCallBrief({ parameters: overTheWire(params) }, SECRET)).toEqual({
      id: "call_1",
      prompt,
    });
    // The longest prompt of nothing but emoji still fits in nine chunks.
    const emoji = "😀".repeat(MAX_CALL_BRIEF_PROMPT_CHARS / 2);
    const wide = await signCallBrief({ id: "call_2", prompt: emoji }, SECRET);
    expect(Object.keys(wide)).toHaveLength(2 + 9);
    expect(await readCallBrief({ parameters: overTheWire(wide) }, SECRET)).toEqual({
      id: "call_2",
      prompt: emoji,
    });
  });

  test("an empty prompt is a brief with no chunks, and still round-trips", async () => {
    const params = await signCallBrief({ id: "call_1", prompt: "" }, SECRET);
    expect(Object.keys(params).sort()).toEqual(["call", "sig"]);
    expect(await readCallBrief({ parameters: params }, SECRET)).toEqual({
      id: "call_1",
      prompt: "",
    });
  });

  test("refuses a prompt over the cap, an empty id, and an id carrying the separator", async () => {
    const long = "x".repeat(MAX_CALL_BRIEF_PROMPT_CHARS + 1);
    await expect(signCallBrief({ id: "call_1", prompt: long }, SECRET)).rejects.toThrow(RangeError);
    await expect(signCallBrief({ id: "", prompt: "p" }, SECRET)).rejects.toThrow(RangeError);
    await expect(signCallBrief({ id: "a\nb", prompt: "p" }, SECRET)).rejects.toThrow(RangeError);
  });
});

describe("readCallBrief", () => {
  test("reassembles a brief signed with the same secret", async () => {
    const prompt = "y".repeat(CALL_BRIEF_CHUNK_CHARS + 3);
    const params = await signCallBrief({ id: "call_9", prompt }, SECRET);
    expect(await readCallBrief({ parameters: params }, SECRET)).toEqual({ id: "call_9", prompt });
  });

  test("answers undefined for a wrong secret, a tampered prompt, a dropped chunk, or none", async () => {
    const params = await signCallBrief(BRIEF, SECRET);
    expect(await readCallBrief({ parameters: params }, "other-secret")).toBeUndefined();
    expect(await readCallBrief({ parameters: params }, undefined)).toBeUndefined();
    expect(await readCallBrief({ parameters: params }, "")).toBeUndefined();
    expect(
      await readCallBrief({ parameters: { ...params, p0: "Book a table for TEN." } }, SECRET),
    ).toBeUndefined();
    const { p0: _, ...truncated } = await signCallBrief(
      { id: "call_1", prompt: "z".repeat(CALL_BRIEF_CHUNK_CHARS + 1) },
      SECRET,
    );
    expect(await readCallBrief({ parameters: truncated }, SECRET)).toBeUndefined();
  });

  test("refuses an id carrying a newline, so a signed brief cannot be re-read with a shifted id", async () => {
    const params = await signCallBrief({ id: "call_9", prompt: "Line one\nLine two" }, SECRET);
    expect(await readCallBrief({ parameters: params }, SECRET)).toEqual({
      id: "call_9",
      prompt: "Line one\nLine two",
    });
    // The same signature over the same signed text, with the split moved.
    const shifted = { call: "call_9\nLine one", sig: params.sig ?? "", p0: "Line two" };
    expect(await readCallBrief({ parameters: shifted }, SECRET)).toBeUndefined();
    expect(await readCallBrief({ parameters: overTheWire(shifted) }, SECRET)).toBeUndefined();
  });

  test("trims the secret as the dialler does, and a blank one is absent", async () => {
    const params = await signCallBrief(BRIEF, SECRET);
    expect(await readCallBrief({ parameters: params }, `${SECRET} \n`)).toEqual(BRIEF);
    expect(await readCallBrief({ parameters: params }, " \n")).toBeUndefined();
  });

  test("a stream with no brief at all — a stranger's, or a plain parameter set — is undefined", async () => {
    expect(await readCallBrief({ parameters: {} }, SECRET)).toBeUndefined();
    expect(await readCallBrief({ parameters: { call: "call_1" } }, SECRET)).toBeUndefined();
    expect(await readCallBrief({ parameters: { for: "Sam" } }, SECRET)).toBeUndefined();
  });
});

describe("isCallBriefParameter", () => {
  test("names the three the brief occupies and nothing else", () => {
    for (const name of ["call", "sig", "p0", "p12"]) expect(isCallBriefParameter(name)).toBe(true);
    for (const name of ["for", "p", "px", "calls", "signature"]) {
      expect(isCallBriefParameter(name)).toBe(false);
    }
  });
});
