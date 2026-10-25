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
