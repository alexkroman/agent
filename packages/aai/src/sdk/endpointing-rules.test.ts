// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_MAX_TURN_SILENCE_MS, DEFAULT_MIN_TURN_SILENCE_MS } from "./constants.ts";
import {
  clampEndpointingTimeout,
  DEFAULT_ENDPOINTING_RULES,
  type EndpointingRule,
  MAX_ENDPOINTING_RULE_TIMEOUT_MS,
  matchEndpointingRule,
} from "./endpointing-rules.ts";

describe("matchEndpointingRule", () => {
  test("an assistant rule reads the agent's last message and not the caller's", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "assistant", regex: "order number", timeoutMs: 2600 },
    ];
    expect(matchEndpointingRule(rules, { assistantMessage: "What's your order number?" })).toEqual({
      index: 0,
      timeoutMs: 2600,
    });
    expect(
      matchEndpointingRule(rules, { userTranscript: "my order number is twelve" }),
    ).toBeUndefined();
  });

  test("a user rule reads the in-flight transcript and not the agent's message", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "user", regex: "\\d\\s*$", timeoutMs: 2600 },
    ];
    expect(matchEndpointingRule(rules, { userTranscript: "it's one nine one" })).toBeUndefined();
    expect(matchEndpointingRule(rules, { userTranscript: "it's 191" })?.timeoutMs).toBe(2600);
    expect(matchEndpointingRule(rules, { assistantMessage: "order 191" })).toBeUndefined();
  });

  test("a both rule is an AND, so one side alone does not match", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "both", assistantRegex: "zip", userRegex: "\\d$", timeoutMs: 3000 },
    ];
    expect(matchEndpointingRule(rules, { assistantMessage: "your zip?" })).toBeUndefined();
    expect(matchEndpointingRule(rules, { userTranscript: "191" })).toBeUndefined();
    expect(
      matchEndpointingRule(rules, { assistantMessage: "your zip?", userTranscript: "191" })
        ?.timeoutMs,
    ).toBe(3000);
  });

  test("FIRST match wins, in declaration order — not the longest or most specific", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "assistant", regex: "number", timeoutMs: 2600 },
      { type: "assistant", regex: "what is your order number exactly", timeoutMs: 900 },
    ];
    expect(
      matchEndpointingRule(rules, { assistantMessage: "what is your order number exactly?" }),
    ).toEqual({ index: 0, timeoutMs: 2600 });
  });

  test("matching is RegExp.test, so a bare pattern matches a SUBSTRING", () => {
    const rules: readonly EndpointingRule[] = [{ type: "user", regex: "order", timeoutMs: 2000 }];
    // The trap this documents: "reorder" contains "order".
    expect(matchEndpointingRule(rules, { userTranscript: "I want to reorder" })?.index).toBe(0);
    // Anchoring is the author's job, and it works.
    const anchored: readonly EndpointingRule[] = [
      { type: "user", regex: "\\border\\b", timeoutMs: 2000 },
    ];
    expect(matchEndpointingRule(anchored, { userTranscript: "I want to reorder" })).toBeUndefined();
  });

  test('patterns are case-insensitive by default, and `flags: ""` opts out', () => {
    const insensitive: readonly EndpointingRule[] = [
      { type: "assistant", regex: "ORDER", timeoutMs: 2000 },
    ];
    expect(matchEndpointingRule(insensitive, { assistantMessage: "your order" })?.index).toBe(0);
    const sensitive: readonly EndpointingRule[] = [
      { type: "assistant", regex: "ORDER", flags: "", timeoutMs: 2000 },
    ];
    expect(matchEndpointingRule(sensitive, { assistantMessage: "your order" })).toBeUndefined();
  });

  test("an absent side is a non-match rather than a match against the empty string", () => {
    const rules: readonly EndpointingRule[] = [{ type: "user", regex: "\\w", timeoutMs: 2000 }];
    expect(matchEndpointingRule(rules, {})).toBeUndefined();
  });

  test("a rule over the declaration cap is clamped rather than honoured", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "user", regex: "x", timeoutMs: MAX_ENDPOINTING_RULE_TIMEOUT_MS * 10 },
    ];
    expect(matchEndpointingRule(rules, { userTranscript: "x" })?.timeoutMs).toBe(
      MAX_ENDPOINTING_RULE_TIMEOUT_MS,
    );
  });

  test("an uncompilable pattern never matches and never throws", () => {
    const rules: readonly EndpointingRule[] = [
      { type: "user", regex: "(unclosed", timeoutMs: 2000 },
      { type: "user", regex: "fallback", timeoutMs: 1200 },
    ];
    expect(matchEndpointingRule(rules, { userTranscript: "(unclosed" })?.index).toBe(undefined);
    expect(matchEndpointingRule(rules, { userTranscript: "fallback" })?.index).toBe(1);
  });

  test("an empty table matches nothing, which is how the feature is switched off", () => {
    expect(
      matchEndpointingRule([], { assistantMessage: "order number", userTranscript: "19" }),
    ).toBeUndefined();
  });
});

describe("clampEndpointingTimeout", () => {
  test("a rule may never put the STT's floor above its ceiling", () => {
    expect(clampEndpointingTimeout(5000, DEFAULT_MAX_TURN_SILENCE_MS)).toBe(
      DEFAULT_MAX_TURN_SILENCE_MS,
    );
  });

  test("a shorter wait passes through, which is what a yes/no rule needs", () => {
    expect(clampEndpointingTimeout(900, DEFAULT_MAX_TURN_SILENCE_MS)).toBe(900);
  });

  test("zero is floored to 1 — on the wire 0 means 'use the service default'", () => {
    expect(clampEndpointingTimeout(0, DEFAULT_MAX_TURN_SILENCE_MS)).toBe(1);
  });
});

describe("DEFAULT_ENDPOINTING_RULES", () => {
  const match = (input: { assistantMessage?: string; userTranscript?: string }) =>
    matchEndpointingRule(DEFAULT_ENDPOINTING_RULES, input);

  test("every shipped rule fits under the cap and under the STT ceiling", () => {
    for (const rule of DEFAULT_ENDPOINTING_RULES) {
      expect(rule.timeoutMs).toBeLessThanOrEqual(MAX_ENDPOINTING_RULE_TIMEOUT_MS);
      expect(rule.timeoutMs).toBeLessThanOrEqual(DEFAULT_MAX_TURN_SILENCE_MS);
    }
  });

  test("a caller SPELLING gets the longest wait, however the ASR punctuated it", () => {
    // The measured failure: "S-O-F-I-A, last name Lee, L-I" — a caller
    // spelling because the agent already mis-heard them once.
    for (const spelled of ["it's S-O-F-I-A", "Y U S U F", "s. o. f."]) {
      expect(match({ userTranscript: spelled })?.timeoutMs).toBe(3000);
    }
  });

  test("...including a TWO-letter spelling, which is the measured tail of the utterance", () => {
    // "S-O-F-I-A, last name Lee, L-I" — the anchor is the end of the
    // transcript, so at the moment this has to decide, `L-I` is all it sees.
    expect(match({ userTranscript: "last name Lee, L-I" })?.timeoutMs).toBe(3000);
  });

  test("...and ordinary speech is not mistaken for spelling", () => {
    // Two one-letter tokens are not a spelling run, and a normal sentence
    // ending in a short word is not either.
    for (const ordinary of ["I need a new one", "is that a b", "no thanks"]) {
      const hit = match({ userTranscript: ordinary });
      expect(hit?.timeoutMs).not.toBe(3000);
    }
  });

  test("an identity ask outranks an identifier ask — names are where turns collapse", () => {
    // 9 tau2-bench retail simulations: 41 order-id renderings, one digit
    // substitution, never reaching a tool — against "Yusuf" -> "Yuta" ->
    // "Yufus" and three failed lookups. So this rule sits above the
    // identifier one and carries the longer window.
    for (const asked of [
      "Can I get your last name?",
      "What's the name on the account?",
      "Could you spell that for me?",
      "May I have your name?",
    ]) {
      expect(match({ assistantMessage: asked })?.timeoutMs).toBe(3000);
    }
  });

  test("an identifier ask buys patience above the 1600ms baseline", () => {
    for (const asked of [
      "Can I get your order number?",
      "What's the email on the account?",
      "And your zip code?",
      "What's the tracking number?",
    ]) {
      const hit = match({ assistantMessage: asked });
      expect(hit?.timeoutMs).toBeGreaterThan(DEFAULT_MIN_TURN_SILENCE_MS);
    }
  });

  test("a transcript ending in a digit buys the same patience", () => {
    expect(match({ userTranscript: "it's one nine one two 2" })?.timeoutMs).toBe(2600);
    // Trailing whitespace is what an interim actually carries.
    expect(match({ userTranscript: "19122 " })?.timeoutMs).toBe(2600);
    expect(match({ userTranscript: "that's all" })).toBeUndefined();
  });

  test("EVERY shipped rule lengthens the wait or leaves it alone — none shortens it", () => {
    // The table's central property. A lengthening rule that fires wrongly
    // makes the agent slower; a shortening one truncates the CALLER, which
    // corrupts the turn's meaning — and the harm is invisible to a benchmark
    // that cannot read a reward flip at n=3. So a shortening default would be
    // a change nobody could evaluate, in the expensive direction.
    for (const rule of DEFAULT_ENDPOINTING_RULES) {
      expect(rule.timeoutMs).toBeGreaterThanOrEqual(DEFAULT_MIN_TURN_SILENCE_MS);
    }
  });

  test("the closed-question rule is PRESENT and NEUTRAL", () => {
    // Present, so the pattern is written down one number from live; neutral,
    // because only a LOWER bound on it is measured (the ~470ms first-partial
    // model floor), and not the distribution of caller responses to closed
    // questions that would be needed to ship the shorter value.
    const hit = match({ assistantMessage: "Is that the one ending in 4?" });
    expect(hit?.timeoutMs).toBe(DEFAULT_MIN_TURN_SILENCE_MS);
  });

  test("...and being neutral costs no wire frame, because the push is change-gated", () => {
    // The property that makes "present but neutral" free rather than merely
    // harmless: the resolved value equals the base, and the transport only
    // pushes a CHANGE (`pipeline-endpointing.ts`).
    expect(match({ assistantMessage: "Is that right?" })?.timeoutMs).toBe(
      DEFAULT_MIN_TURN_SILENCE_MS,
    );
  });

  test("an identifier ask phrased as a closed question still buys the LONGER wait", () => {
    // Both rules match "Can you give me your order number?" and the ordering
    // of the shipped table is what decides it — the expensive failure is a
    // truncated identifier, so patience has to come first.
    expect(match({ assistantMessage: "Can you give me your order number?" })?.timeoutMs).toBe(2600);
  });

  test("ordinary conversation matches nothing, so the baseline stands", () => {
    expect(
      match({ assistantMessage: "I've cancelled that for you.", userTranscript: "thanks" }),
    ).toBeUndefined();
  });
});
