// Copyright 2026 the AAI authors. MIT license.
/**
 * The three ASR-steering parameters this adapter dials beyond the endpointing
 * pair — `keyterms_prompt`, `agent_context` from the descriptor, and
 * `format_turns` — plus the mid-stream keyterm update.
 *
 * Its own file rather than a block in `assemblyai-connect-params.test.ts`:
 * that suite was written around "a default that stops reaching the wire is
 * invisible", and these are the opposite case — parameters an author has to
 * ASK for, each of which is silently ignored by the service on some model. The
 * failure they guard is a knob that appears to be set and is not.
 */

import { type AssemblyAISttOptions, assemblyAIStt } from "@alexkroman1/aai/stt";
import { describe, expect, test, vi } from "vitest";
import { fakeOf, openSessionWith } from "./_assemblyai-test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

vi.mock("assemblyai", async () => {
  const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
  return assemblyAIModuleMock();
});

async function openSession(
  providerOpts: AssemblyAISttOptions,
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  return openSessionWith(openAssemblyAI, providerOpts, openOpts);
}

describe("assemblyAIStt STT adapter — keyterms", () => {
  test("an agent that declares none sends no keyterms_prompt at all", async () => {
    // Not `[]`: an empty list is the wire's way of CLEARING biasing, which is
    // a mid-stream act and means nothing at connect.
    const session = await openSession({});
    expect("keytermsPrompt" in fakeOf(session).params).toBe(false);
    await session.close();
  });

  test("declared keyterms reach the connect params, normalized", async () => {
    const session = await openSession({
      keyterms: ["  gift card ", "gift card", "x".repeat(60), "order number"],
    });
    // Trimmed, de-duplicated, and the over-long one dropped — all before the
    // wire, because the service ignores an over-long term silently.
    expect(fakeOf(session).params.keytermsPrompt).toEqual(["gift card", "order number"]);
    await session.close();
  });

  test("updateKeyterms replaces them mid-stream, and skips an unchanged list", async () => {
    const session = await openSession({ keyterms: ["gift card"] });
    const fake = fakeOf(session);

    // Called once per agent turn: the overwhelming majority change nothing,
    // and a wire message per turn is noise on the socket carrying the audio.
    session.updateKeyterms?.(["gift card"]);
    expect(fake.updateConfigurationCalls).toEqual([]);

    session.updateKeyterms?.(["order number", "item number"]);
    expect(fake.updateConfigurationCalls).toEqual([
      { keyterms_prompt: ["order number", "item number"] },
    ]);

    await session.close();
  });

  test("updateKeyterms(undefined) RESTORES the connect-time list", async () => {
    // What a dialog state ENDING means: the phase that narrowed the vocabulary
    // is over, and the agent's own list must come back — not be cleared.
    const session = await openSession({ keyterms: ["gift card"] });
    const fake = fakeOf(session);

    session.updateKeyterms?.(["order number"]);
    session.updateKeyterms?.(undefined);

    expect(fake.updateConfigurationCalls).toEqual([
      { keyterms_prompt: ["order number"] },
      { keyterms_prompt: ["gift card"] },
    ]);
    await session.close();
  });

  test("updateKeyterms([]) CLEARS biasing — a different claim from undefined", async () => {
    const session = await openSession({ keyterms: ["gift card"] });
    const fake = fakeOf(session);
    session.updateKeyterms?.([]);
    expect(fake.updateConfigurationCalls).toEqual([{ keyterms_prompt: [] }]);
    await session.close();
  });

  test("a multi-word term is not confused with its own words", async () => {
    // The unchanged-list check compares a joined string; joining on a space
    // would make ["gift card"] and ["gift", "card"] the same list and skip a
    // real update.
    const session = await openSession({ keyterms: ["gift card"] });
    const fake = fakeOf(session);
    session.updateKeyterms?.(["gift", "card"]);
    expect(fake.updateConfigurationCalls).toEqual([{ keyterms_prompt: ["gift", "card"] }]);
    await session.close();
  });

  test("the closed session sends nothing", async () => {
    const session = await openSession({ keyterms: ["gift card"] });
    const fake = fakeOf(session);
    await session.close();
    session.updateKeyterms?.(["order number"]);
    expect(fake.updateConfigurationCalls).toEqual([]);
  });
});

describe("assemblyAIStt STT adapter — descriptor agentContext", () => {
  test("the descriptor's context wins over the host's greeting seed", async () => {
    const session = await openSession(
      { agentContext: "Retail support call about an existing order." },
      { agentContext: "Thanks for calling, how can I help?" },
    );
    expect(fakeOf(session).params.agentContext).toBe(
      "Retail support call about an existing order.",
    );
    await session.close();
  });

  test("with no descriptor context the greeting is still seeded", async () => {
    const session = await openSession({}, { agentContext: "Thanks for calling." });
    expect(fakeOf(session).params.agentContext).toBe("Thanks for calling.");
    await session.close();
  });

  test("a non-3.5-pro model gets neither", async () => {
    const session = await openSession(
      { model: "universal-streaming-english", agentContext: "Retail support call." },
      { agentContext: "Thanks for calling." },
    );
    expect("agentContext" in fakeOf(session).params).toBe(false);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — formatTurns", () => {
  test("unset sends nothing, leaving the model's own behaviour", async () => {
    const session = await openSession({ model: "universal-streaming-english" });
    expect("formatTurns" in fakeOf(session).params).toBe(false);
    await session.close();
  });

  test("reaches the wire on a model where it IS a parameter", async () => {
    const on = await openSession({ model: "universal-streaming-english", formatTurns: true });
    expect(fakeOf(on).params.formatTurns).toBe(true);
    await on.close();

    // `false` must survive as false rather than being read as "unset".
    const off = await openSession({ model: "universal-streaming-english", formatTurns: false });
    expect(fakeOf(off).params.formatTurns).toBe(false);
    await off.close();
  });

  test("is NOT sent on universal-3-5-pro, and says so", async () => {
    // Formatting is always on there and `format_turns` is not a parameter, so
    // sending it would be a request the service ignores — and an author who
    // asked for `false` would believe they had turned formatting off.
    //
    // The spy has to be installed BEFORE the module loads: `consoleLogger`
    // binds `console.warn` when it is constructed, so a spy installed
    // afterwards never sees the call. Same trick the AAI_DEBUG trace test
    // uses, and the reason `openSessionWith` takes the opener as an argument.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import("./assemblyai.ts");
    const session = await openSessionWith(fresh.openAssemblyAI, {
      model: "universal-3-5-pro",
      formatTurns: false,
    });
    expect("formatTurns" in fakeOf(session).params).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("universal-3-5-pro"),
    );
    warn.mockRestore();
    await session.close();
  });

  test("with formatting on, only the FORMATTED final commits", async () => {
    const session = await openSession({ model: "universal-streaming-english", formatTurns: true });
    const fake = fakeOf(session);
    const seen: { kind: string; text: string }[] = [];
    session.on("partial", (text) => seen.push({ kind: "partial", text }));
    session.on("final", (text) => seen.push({ kind: "final", text }));

    // The service sends two end_of_turn messages for one turn. Treating both
    // as finals would answer the same sentence twice.
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: false,
      transcript: "my number is nine seven two",
      words: [],
    });
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: "My number is 972.",
      words: [],
    });

    expect(seen).toEqual([
      { kind: "partial", text: "my number is nine seven two" },
      { kind: "final", text: "My number is 972." },
    ]);
    await session.close();
  });

  test("with formatting off, the single final commits as it always did", async () => {
    const session = await openSession({ model: "universal-streaming-english" });
    const fake = fakeOf(session);
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: false,
      transcript: "my number is nine seven two",
      words: [],
    });
    expect(finals).toEqual(["my number is nine seven two"]);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — word confidence on the turn", () => {
  test("a turn's per-word scores ride out as meta", async () => {
    const session = await openSession({});
    const fake = fakeOf(session);
    const metas: unknown[] = [];
    session.on("final", (_text, meta) => metas.push(meta));

    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: "order W two three seven",
      end_of_turn_confidence: 0.9,
      words: [{ confidence: 0.95 }, { confidence: 0.35 }],
    });

    expect(metas).toEqual([
      {
        endOfTurnConfidence: 0.9,
        transcriptConfidence: expect.closeTo(0.65, 10),
        minWordConfidence: 0.35,
      },
    ]);
    await session.close();
  });

  test("a wordless turn carries no confidence keys at all", async () => {
    const session = await openSession({});
    const fake = fakeOf(session);
    const metas: unknown[] = [];
    session.on("final", (_text, meta) => metas.push(meta));

    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: "hello",
      words: [],
    });

    // Absent, not zero: the policy downstream reads absence as "no opinion".
    expect(metas).toEqual([{}]);
    await session.close();
  });
});

describe("assemblyAIStt descriptor", () => {
  test("carries the steering options through as plain data", () => {
    const descriptor = assemblyAIStt({
      keyterms: ["gift card"],
      agentContext: "Retail support call.",
      formatTurns: true,
    });
    expect(descriptor.options).toEqual({
      keyterms: ["gift card"],
      agentContext: "Retail support call.",
      formatTurns: true,
    });
  });
});
