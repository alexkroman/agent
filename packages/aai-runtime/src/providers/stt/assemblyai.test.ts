// Copyright 2025 the AAI authors. MIT license.
/**
 * What the AssemblyAI STT adapter does with a LIVE stream — turn events and
 * their confidence, fixture replay, the `AAI_DEBUG` turn trace, mid-stream
 * `agent_context` updates, and outbound frame coalescing.
 *
 * Everything that lands on the connect URL lives in
 * `assemblyai-connect-params.test.ts`; the two share
 * `_assemblyai-test-utils.ts`.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent } from "assemblyai";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { fakeOf, openSessionWith } from "./_assemblyai-test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

const here = dirname(fileURLToPath(import.meta.url));

vi.mock("assemblyai", async () => {
  const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
  return assemblyAIModuleMock();
});

async function openSession(
  providerOpts: Parameters<typeof openAssemblyAI>[0],
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  return openSessionWith(openAssemblyAI, providerOpts, openOpts);
}

describe("assemblyAIStt STT adapter — end_of_turn_confidence", () => {
  /**
   * A caller dictating a phone number, as the service actually reports it.
   * The point of the sequence is that confidence is NOT monotonic: it climbs
   * while a prefix settles, then RESETS to 0 when the caller speaks the next
   * group. Any consumer that treats a rise as "they are done" fires mid-number
   * — which is the truncation the silence-window knobs already struggle with.
   */
  const DICTATED_NUMBER = [
    { transcript: "3 of", end_of_turn_confidence: 0 },
    { transcript: "302.", end_of_turn_confidence: 0 },
    { transcript: "302.", end_of_turn_confidence: 0.25 },
    { transcript: "302-746-", end_of_turn_confidence: 0 },
    { transcript: "302-743-", end_of_turn_confidence: 0.175 },
    { transcript: "302-743-", end_of_turn_confidence: 0.275 },
    { transcript: "302-743-", end_of_turn_confidence: 0.425 },
    { transcript: "302-743-", end_of_turn_confidence: 0 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.25 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.4 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.55 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.7 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.8 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 0.95 },
    { transcript: "302-743-9958.", end_of_turn_confidence: 1 },
  ];

  test("forwards the per-turn confidence onto the partial/final meta", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const seen: Array<number | undefined> = [];
    session.on("partial", (_t, meta) => seen.push(meta?.endOfTurnConfidence));
    const fake = fakeOf(session);

    for (const turn of DICTATED_NUMBER) {
      fake._fire("turn", { ...turn, end_of_turn: false });
    }
    await flush();

    expect(seen).toEqual(DICTATED_NUMBER.map((t) => t.end_of_turn_confidence));
    // The sawtooth is the property worth pinning: TWO drops back to 0 from a
    // non-zero reading (after 0.25, and after 0.425), each one the caller
    // resuming mid-identifier. A consumer that reads a rising value as "they
    // have finished" fires at both and truncates the number.
    const resets = seen.filter((c, i) => i > 0 && c === 0 && (seen[i - 1] ?? 0) > 0);
    expect(resets).toHaveLength(2);
    // And it only reaches 1.0 once, on the last frame — the genuine end.
    expect(seen.filter((c) => c === 1)).toHaveLength(1);
    expect(seen.at(-1)).toBe(1);

    await session.close();
  });

  test("omits the field entirely when the service does not report it", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const metas: Array<Record<string, unknown> | undefined> = [];
    session.on("final", (_t, meta) => metas.push(meta));
    const fake = fakeOf(session);

    fake._fire("turn", { transcript: "done.", end_of_turn: true } as TurnEvent);
    await flush();

    // Absent, not `undefined` — "the provider said nothing" must be
    // distinguishable from "the provider reported zero confidence".
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toHaveProperty("endOfTurnConfidence");

    await session.close();
  });

  test("a zero reading survives as 0, not as absent", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const seen: Array<number | undefined> = [];
    session.on("partial", (_t, meta) => seen.push(meta?.endOfTurnConfidence));
    const fake = fakeOf(session);

    // No cast: `_fire` takes `...args: unknown[]`, so the extra field the
    // SDK type does not declare needs no laundering to reach the adapter.
    fake._fire("turn", { transcript: "3 of", end_of_turn: false, end_of_turn_confidence: 0 });
    await flush();

    expect(seen).toEqual([0]);

    await session.close();
  });
});

describe("assemblyAIStt STT adapter — fixture replay", () => {
  test("maps turn events onto partial/final SttEvents", async () => {
    const fixture = JSON.parse(
      await readFile(join(here, "fixtures/assemblyai/basic-turn.json"), "utf8"),
    ) as Record<string, unknown>[];

    const session = await openSession({ model: "universal-3-5-pro" });

    const partials: string[] = [];
    const finals: string[] = [];
    const errors: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));
    session.on("error", (e) => errors.push(e.message));

    const fake = fakeOf(session);
    for (const msg of fixture) {
      if (msg.type === "Turn") fake._fire("turn", msg as TurnEvent);
    }

    await flush();

    expect(partials).toEqual(["what", "what's the"]);
    expect(finals).toEqual(["what's the weather?"]);
    expect(errors).toEqual([]);

    await session.close();
  });
});

describe("assemblyAIStt STT adapter — raw turn trace (AAI_DEBUG)", () => {
  /**
   * Load a fresh module graph with debug logging on, so `consoleLogger.debug`
   * (bound at import time from `debugLoggingEnabled`) is live `console.debug`.
   */
  async function withDebugModule(): Promise<{
    open: typeof openAssemblyAI;
    debugSpy: ReturnType<typeof vi.spyOn>;
  }> {
    vi.stubEnv("AAI_DEBUG", "1");
    vi.resetModules();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const mod = await import("./assemblyai.ts");
    return { open: mod.openAssemblyAI, debugSpy };
  }

  test("traces each raw turn event with its end_of_turn and formatted flags", async () => {
    // Diagnosing "the model called a tool with an argument the user never
    // said" needs the provider's raw view: a word can appear in an interim
    // turn and be revised out of the final one. Without end_of_turn /
    // turn_is_formatted on the trace, an STT revision is indistinguishable
    // from the transport dropping a final.
    const { open, debugSpy } = await withDebugModule();
    const provider = open({ model: "u3pro-rt" });
    const session = (await provider.open({
      sampleRate: 16_000,
      apiKey: "k",
      signal: new AbortController().signal,
    })) as AssemblyAISession;
    const fake = fakeOf(session);

    fake._fire("turn", { transcript: "track my order T-O-999", end_of_turn: false } as TurnEvent);
    fake._fire("turn", {
      transcript: "I've been waiting on that one.",
      end_of_turn: true,
      turn_is_formatted: true,
    } as TurnEvent);
    await flush();

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "AssemblyAI STT turn",
      expect.objectContaining({
        transcript: "track my order T-O-999",
        endOfTurn: false,
      }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "AssemblyAI STT turn",
      expect.objectContaining({
        transcript: "I've been waiting on that one.",
        endOfTurn: true,
        formatted: true,
      }),
    );

    await session.close();
  });

  test("traces empty-transcript turns, which are otherwise dropped silently", async () => {
    // The adapter returns early on empty text; without a trace those events
    // are invisible, and "STT went quiet" looks the same as "no audio".
    const { open, debugSpy } = await withDebugModule();
    const provider = open({ model: "u3pro-rt" });
    const session = (await provider.open({
      sampleRate: 16_000,
      apiKey: "k",
      signal: new AbortController().signal,
    })) as AssemblyAISession;
    const fake = fakeOf(session);

    fake._fire("turn", { transcript: "", end_of_turn: true } as TurnEvent);
    await flush();

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "AssemblyAI STT turn",
      expect.objectContaining({ transcript: "", endOfTurn: true }),
    );

    await session.close();
  });
});

describe("assemblyAIStt STT adapter — agent_context (Universal-3.5 Pro only)", () => {
  test("universal-3-5-pro: passes agentContext at connect and updates it mid-stream", async () => {
    const session = await openSession(
      { model: "universal-3-5-pro" },
      { agentContext: "Hi, how can I help you today?" },
    );
    const fake = fakeOf(session);

    expect(fake.params.agentContext).toBe("Hi, how can I help you today?");

    session.updateAgentContext?.("Sure, I can help with that.");
    expect(fake.updateConfigurationCalls).toEqual([
      { agent_context: "Sure, I can help with that." },
    ]);

    await session.close();
  });

  test("u3-rt-pro: trims agentContext to 1500 chars, both at connect and mid-stream", async () => {
    const long = "x".repeat(2000);
    const trimmed = "x".repeat(1500);

    const session = await openSession({ model: "u3-rt-pro" }, { agentContext: long });
    const fake = fakeOf(session);

    expect(fake.params.agentContext).toBe(trimmed);

    session.updateAgentContext?.(long);
    expect(fake.updateConfigurationCalls).toEqual([{ agent_context: trimmed }]);

    await session.close();
  });

  test("over-long agent context keeps the tail, where the question is", async () => {
    // Docs: "Trim long agent replies down to the substantive question before
    // sending." A voice agent's question is at the *end* of its reply, so
    // truncating from the front drops the one part worth sending.
    const long = `${"filler. ".repeat(400)}What is your email address?`;
    expect(long.length).toBeGreaterThan(1500);

    const session = await openSession({ model: "universal-3-5-pro" }, { agentContext: long });
    const fake = fakeOf(session);
    expect((fake.params.agentContext as string).length).toBe(1500);
    expect(fake.params.agentContext).toContain("What is your email address?");

    session.updateAgentContext?.(long);
    const sent = fake.updateConfigurationCalls[0]?.agent_context as string;
    expect(sent.length).toBe(1500);
    expect(sent).toContain("What is your email address?");
    await session.close();
  });

  test("universal-3-5-pro: skips empty/whitespace-only agentContext, both at connect and mid-stream", async () => {
    const session = await openSession({ model: "universal-3-5-pro" }, { agentContext: "   " });
    const fake = fakeOf(session);

    expect(fake.params.agentContext).toBeUndefined();

    session.updateAgentContext?.("\n\t ");
    expect(fake.updateConfigurationCalls).toEqual([]);

    await session.close();
  });

  test("non-3.5-pro model: no agentContext at connect, and updateAgentContext is a no-op", async () => {
    const session = await openSession(
      { model: "universal-streaming-english" },
      { agentContext: "Hi, how can I help you today?" },
    );
    const fake = fakeOf(session);

    expect(fake.params.agentContext).toBeUndefined();
    expect("agentContext" in fake.params).toBe(false);

    session.updateAgentContext?.("Sure, I can help with that.");
    expect(fake.updateConfigurationCalls).toEqual([]);

    await session.close();
  });
});

describe("assemblyAIStt STT adapter — frame coalescing (50–1000 ms)", () => {
  // At 16 kHz mono PCM16: 20 ms = 320 samples, 50 ms = 800, 100 ms = 1600,
  // 1000 ms = 16000. AssemblyAI streaming rejects frames outside [50, 1000] ms.
  const SAMPLES_20MS = 320;
  const SAMPLES_100MS = 1600;
  const SAMPLES_1000MS = 16_000;

  test("buffers sub-100 ms frames and forwards one ~100 ms frame once accumulated", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);

    const frame20 = new Int16Array(SAMPLES_20MS); // reused: exercises the copy
    for (let i = 0; i < 4; i++) session.sendAudio(frame20); // 80 ms — nothing yet
    expect(fake.sentAudio.length).toBe(0);

    session.sendAudio(frame20); // 5th frame → 100 ms accumulated → one flush
    expect(fake.sentAudio.length).toBe(1);
    expect(fake.sentAudio[0]?.byteLength).toBe(SAMPLES_100MS * 2);

    await session.close();
  });

  test("splits an over-long chunk into frames capped at 1000 ms", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);

    // 1000 ms + 70 ms in a single call: forwards one 1000 ms frame, carries 70 ms.
    session.sendAudio(new Int16Array(SAMPLES_1000MS + 1120));
    expect(fake.sentAudio.length).toBe(1);
    expect(fake.sentAudio[0]?.byteLength).toBe(SAMPLES_1000MS * 2);

    // close() flushes the ≥50 ms remainder.
    await session.close();
    expect(fake.sentAudio.length).toBe(2);
    expect(fake.sentAudio[1]?.byteLength).toBe(1120 * 2);
  });

  test("drops a sub-50 ms tail on close (below AssemblyAI's floor)", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);

    session.sendAudio(new Int16Array(SAMPLES_20MS)); // 20 ms, held below 100 ms
    expect(fake.sentAudio.length).toBe(0);

    await session.close(); // 20 ms < 50 ms floor → dropped, not forwarded
    expect(fake.sentAudio.length).toBe(0);
  });
});
