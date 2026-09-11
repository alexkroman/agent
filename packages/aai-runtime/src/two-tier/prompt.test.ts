// Copyright 2026 the AAI authors. MIT license.
// Both tiers' instructions and the slow tier's brief. UNIT tier.
//
// Most of what matters about these strings cannot be tested — whether a
// sentence would pass the litmus test in `prompt.ts` is a judgement on a fresh
// read, and Pickle removed their own keyword check for exactly that reason: a
// passing blacklist creates false confidence, and their full-prompt review
// found benchmark-shaped content in a prompt the test had accepted.
//
// So what this file asserts is the two mechanical claims instead: the brief
// carries everything the view carries and nothing else, and the fast tier's
// instructions actually contain the no-false-completion rule the whole
// architecture leans on.

import type { Message } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { createDigestStore } from "./digest.ts";
import {
  FAST_TIER_INSTRUCTIONS,
  renderSlowTierBrief,
  SLOW_TIER_SYSTEM_PROMPT,
  STATE_SUMMARY_DESCRIPTION,
} from "./prompt.ts";
import { slowTierViewOf } from "./view.ts";

const SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    name: "look_up_order",
    description: "Read an order",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "change_address",
    description: "Change an address",
    parameters: { type: "object", properties: {} },
    mutates: true,
  },
];

const MESSAGES: Message[] = [
  { role: "user", content: "Change my address." },
  { role: "assistant", content: "One moment." },
  { role: "tool", content: '{"ok":true}', toolName: "look_up_order" },
];

const viewOf = (digestSetup?: (d: ReturnType<typeof createDigestStore>) => void) => {
  const digest = createDigestStore();
  digestSetup?.(digest);
  return slowTierViewOf(
    { instructions: "You are the orders desk.", messages: MESSAGES, toolSchemas: SCHEMAS },
    digest.read(),
    24,
  );
};

describe("FAST_TIER_INSTRUCTIONS", () => {
  test("says the fast tier cannot act, and forbids claiming completion", () => {
    // The two claims the architecture rests on. Asserted because a reword that
    // dropped either would leave the gate structurally intact and the SPEECH
    // half — the only half a prompt can reach — silently gone.
    expect(FAST_TIER_INSTRUCTIONS).toMatch(/cannot carry out changes yourself/i);
    expect(FAST_TIER_INSTRUCTIONS).toMatch(/unless the work status says it completed/i);
  });

  test("promises the caller's words reach the other tier, since the runtime relays them", () => {
    // TalkAct's fast agent must emit `@slow:` or the information never arrives.
    // Ours must NOT try: the relay is unconditional, and a fast tier that
    // believes it has a directive to emit will say it out loud.
    expect(FAST_TIER_INSTRUCTIONS).toMatch(/reaches them automatically/i);
    expect(FAST_TIER_INSTRUCTIONS).not.toMatch(/@slow/);
  });
});

describe("SLOW_TIER_SYSTEM_PROMPT", () => {
  test("names no tool, which is the litmus test's one mechanical consequence", () => {
    // R1 of Pickle's constitution: prompt text carries zero benchmark proper
    // nouns and no tool names. The slow tier learns its tools from the runtime
    // catalogue in the brief instead — which is why this is assertable at all.
    for (const name of ["tell_user", "ask_user", "task_done", "look_up_order"]) {
      expect(SLOW_TIER_SYSTEM_PROMPT).not.toContain(name);
    }
  });

  test("states that it is the only tier that can act, and demands the summary", () => {
    expect(SLOW_TIER_SYSTEM_PROMPT).toMatch(/the only one of the two who can use tools/i);
    expect(SLOW_TIER_SYSTEM_PROMPT).toMatch(/Every tool call requires a short summary/i);
  });

  test("the summary description says the other tier has no other view", () => {
    // The sentence that makes an under-filled summary the model's problem
    // rather than a silent loss.
    expect(STATE_SUMMARY_DESCRIPTION).toMatch(/REQUIRED on every call/);
    expect(STATE_SUMMARY_DESCRIPTION).toMatch(/ONLY from this summary/);
  });
});

describe("renderSlowTierBrief", () => {
  test("carries the instructions, the catalogue, the conversation and the status", () => {
    const text = renderSlowTierBrief(viewOf());
    expect(text).toContain("You are the orders desk.");
    expect(text).toContain("- look_up_order");
    expect(text).toContain("- change_address (cannot be taken back)");
    expect(text).toContain("CUSTOMER: Change my address.");
    expect(text).toContain("ASSISTANT: One moment.");
    expect(text).toContain('TOOL look_up_order RESULT: {"ok":true}');
    expect(text).toContain("(nothing attempted yet)");
  });

  test("marks a one-way tool and leaves a read unmarked", () => {
    const text = renderSlowTierBrief(viewOf());
    expect(text).toMatch(/- look_up_order: Read an order/);
    expect(text).not.toMatch(/look_up_order \(cannot be taken back\)/);
  });

  test("an EMPTY conversation says so rather than rendering nothing", () => {
    const view = slowTierViewOf(
      { instructions: "i", messages: [], toolSchemas: [] },
      createDigestStore().read(),
      24,
    );
    const text = renderSlowTierBrief(view);
    expect(text).toContain("(nothing said yet)");
    expect(text).toContain("(none)");
  });

  test("the status carries the summary and every entry", () => {
    const text = renderSlowTierBrief(
      viewOf((d) => {
        d.summarize("The address change is queued.");
        d.open("change_address", "w1");
      }),
    );
    expect(text).toContain("The address change is queued.");
    expect(text).toContain("- change_address: pending");
  });

  test("it is ONE message, rebuilt per run — no history of its own", () => {
    // What keeps the slow tier's context equal to the fast tier's rather than
    // accumulating past it. Two renders of the same view are identical, so
    // nothing carries over between runs but the digest.
    expect(renderSlowTierBrief(viewOf())).toBe(renderSlowTierBrief(viewOf()));
  });
});
