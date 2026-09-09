// Copyright 2026 the AAI authors. MIT license.
// The speech HOLD and the guardrail runner — the two halves of an agent-level
// guardrail that make a block real rather than a report after the fact.

import type { AgentGuardrail, AgentSessionContext } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { createSpeechGate, createTurnGuardrails, NO_GUARDRAILS } from "./pipeline-guardrails.ts";
import type { SendTtsOptions } from "./types.ts";

const CONTEXT: AgentSessionContext = {
  sessionId: "s-1",
  env: {},
  slots: createDetachedSlotStore(),
};

/** A recording sink standing in for the transport's `sendTtsText`. */
function recorder() {
  const sent: { text: string; options: SendTtsOptions | undefined }[] = [];
  return {
    sent,
    send: (text: string, options?: SendTtsOptions): void => {
      sent.push({ text, options });
    },
  };
}

describe("createSpeechGate", () => {
  test("disabled, it IS the underlying send", () => {
    // Not merely equivalent: the shipped path for every agent that declares no
    // output guardrail must be the same function object it always was.
    const sink = recorder();
    const gate = createSpeechGate(false, sink.send);
    expect(gate.send).toBe(sink.send);
    gate.hold();
    gate.send("spoken anyway");
    expect(sink.sent.map((s) => s.text)).toEqual(["spoken anyway"]);
  });

  test("a hold buffers recordable sends and release speaks them in order", () => {
    const sink = recorder();
    const gate = createSpeechGate(true, sink.send);
    gate.send("before");
    gate.hold();
    gate.send("one");
    gate.send("two");
    expect(sink.sent.map((s) => s.text)).toEqual(["before"]);
    gate.release();
    expect(sink.sent.map((s) => s.text)).toEqual(["before", "one", "two"]);
  });

  test("discard drops the held text unspoken", () => {
    const sink = recorder();
    const gate = createSpeechGate(true, sink.send);
    gate.hold();
    gate.send("the blocked reply");
    gate.discard();
    gate.send("after");
    expect(sink.sent.map((s) => s.text)).toEqual(["after"]);
  });

  test("FILLER passes straight through a hold", () => {
    // The dead-air cover is what covers the silence a hold creates. Buffering it
    // would mean the caller hears nothing at all while a reply is judged.
    const sink = recorder();
    const gate = createSpeechGate(true, sink.send);
    gate.hold();
    gate.send("held", { record: true });
    gate.send("Still working on that.", { record: false });
    expect(sink.sent.map((s) => s.text)).toEqual(["Still working on that."]);
    gate.discard();
    expect(sink.sent.map((s) => s.text)).toEqual(["Still working on that."]);
  });

  test("release with nothing held is a no-op, and a second one cannot re-speak", () => {
    const sink = recorder();
    const gate = createSpeechGate(true, sink.send);
    gate.hold();
    gate.send("one");
    gate.release();
    gate.release();
    expect(sink.sent.map((s) => s.text)).toEqual(["one"]);
  });
});

describe("createTurnGuardrails", () => {
  const accept: AgentGuardrail = () => true;

  test("no guardrails means no hold and no refusals", async () => {
    const guardrails = createTurnGuardrails({
      context: CONTEXT,
      onError: () => undefined,
      onBlocked: () => undefined,
    });
    expect(guardrails.holdsSpeech).toBe(false);
    await expect(guardrails.checkOutput("anything")).resolves.toBeUndefined();
    expect(NO_GUARDRAILS.holdsSpeech).toBe(false);
  });

  test("the FIRST refusal wins and the rest are not consulted", async () => {
    const later = vi.fn(() => true as const);
    const blocked = vi.fn();
    const guardrails = createTurnGuardrails({
      outputGuardrails: [accept, () => "I can't say that.", later],
      context: CONTEXT,
      onError: () => undefined,
      onBlocked: blocked,
    });
    expect(guardrails.holdsSpeech).toBe(true);
    await expect(guardrails.checkOutput("a dosage of 40 mg")).resolves.toBe("I can't say that.");
    expect(later).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith("output", "I can't say that.");
  });

  test("an async guardrail is awaited", async () => {
    const guardrails = createTurnGuardrails({
      inputGuardrails: [async () => "Please don't read that out."],
      context: CONTEXT,
      onError: () => undefined,
      onBlocked: () => undefined,
    });
    await expect(guardrails.checkInput("123-45-6789")).resolves.toBe("Please don't read that out.");
  });

  test("a THROW fails open, is reported, and does not stop the list", async () => {
    const onError = vi.fn();
    const guardrails = createTurnGuardrails({
      outputGuardrails: [
        () => {
          throw new Error("classifier timed out");
        },
        accept,
      ],
      context: CONTEXT,
      onError,
      onBlocked: () => undefined,
    });
    await expect(guardrails.checkOutput("fine")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("output", expect.any(Error));
  });

  test("an empty-string verdict is an ACCEPT, not a silent block", async () => {
    // A guardrail that returns `""` has said nothing; speaking nothing in place
    // of the reply would be a mute agent with no error anywhere.
    const blocked = vi.fn();
    const guardrails = createTurnGuardrails({
      outputGuardrails: [() => ""],
      context: CONTEXT,
      onError: () => undefined,
      onBlocked: blocked,
    });
    await expect(guardrails.checkOutput("hello")).resolves.toBeUndefined();
    expect(blocked).not.toHaveBeenCalled();
  });

  test("the guardrail is handed the session's own context", async () => {
    const seen: AgentSessionContext[] = [];
    const guardrails = createTurnGuardrails({
      inputGuardrails: [
        (_text, ctx) => {
          seen.push(ctx);
          return true;
        },
      ],
      context: CONTEXT,
      onError: () => undefined,
      onBlocked: () => undefined,
    });
    await guardrails.checkInput("hi");
    expect(seen[0]).toBe(CONTEXT);
  });
});
