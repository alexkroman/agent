// Copyright 2025 the AAI authors. MIT license.
/** Fixture-replay unit test for the AssemblyAI STT adapter. */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent } from "assemblyai";
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_STT_PROMPT,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
} from "../../../sdk/constants.ts";
import {
  ASSEMBLYAI_STREAMING_EU_URL,
  assemblyAIStt,
} from "../../../sdk/providers/stt/assemblyai.ts";
import { flush } from "../../_test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeTranscriber {
  readonly params: Record<string, unknown>;
  readonly updateConfigurationCalls: Record<string, unknown>[];
  readonly sentAudio: ArrayBufferLike[];
  on(ev: string, fn: (...args: unknown[]) => void): void;
  connect(): Promise<void>;
  close(): Promise<void>;
  sendAudio(_data: ArrayBufferLike): void;
  updateConfiguration(config: Record<string, unknown>): void;
  _fire(ev: string, ...args: unknown[]): void;
}

vi.mock("assemblyai", () => {
  function makeFakeTranscriber(params: Record<string, unknown>): FakeTranscriber {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      params,
      updateConfigurationCalls: [],
      sentAudio: [],
      on(ev, fn) {
        const arr = listeners.get(ev) ?? [];
        arr.push(fn);
        listeners.set(ev, arr);
      },
      async connect() {
        this._fire("open", { type: "Begin", id: "mock-sess", expires_at: 0 });
      },
      async close() {
        /* no-op */
      },
      sendAudio(data: ArrayBufferLike) {
        this.sentAudio.push(data);
      },
      updateConfiguration(config: Record<string, unknown>) {
        this.updateConfigurationCalls.push(config);
      },
      _fire(ev, ...args) {
        for (const fn of listeners.get(ev) ?? []) fn(...args);
      },
    };
  }
  return {
    AssemblyAI: class {
      streaming = {
        transcriber: (params: Record<string, unknown>): FakeTranscriber =>
          makeFakeTranscriber(params),
      };
    },
  };
});

async function openSession(
  providerOpts: Parameters<typeof openAssemblyAI>[0],
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  const provider = openAssemblyAI(providerOpts);
  const controller = new AbortController();
  return (await provider.open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
    ...openOpts,
  })) as AssemblyAISession;
}

/**
 * The mocked `assemblyai` module hands the adapter a {@link FakeTranscriber},
 * but `AssemblyAISession._transcriber` is typed as the real SDK's
 * `StreamingTranscriber` — structurally unrelated shapes, so the narrowing
 * needs a cast. Keep it to this one seam rather than repeating it at every
 * assertion; the escape-hatch ratchet counts each occurrence.
 */
function fakeOf(session: AssemblyAISession): FakeTranscriber {
  return session._transcriber as unknown as FakeTranscriber;
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

describe("assemblyAIStt STT adapter — prompt default", () => {
  test("sends no prompt when the agent configures none (default is empty)", async () => {
    // Biasing is opt-in: a generic identifier prompt measured no better than
    // none, and an off-target one steers the transcript toward vocabulary the
    // caller never used. Agents that need it supply their own.
    expect(DEFAULT_STT_PROMPT).toBe("");
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect("prompt" in fake.params).toBe(false);
    await session.close();
  });

  test("an agent's own sttPrompt replaces the default", async () => {
    const session = await openSession(
      { model: "universal-3-5-pro" },
      { sttPrompt: "Terms: dosage names." },
    );
    const fake = fakeOf(session);
    expect(fake.params.prompt).toBe("Terms: dosage names.");
    await session.close();
  });

  test("sttPrompt: '' opts out — no prompt param at all", async () => {
    const session = await openSession({ model: "universal-3-5-pro" }, { sttPrompt: "" });
    const fake = fakeOf(session);
    expect("prompt" in fake.params).toBe(false);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — voice focus", () => {
  test("defaults voiceFocus to near-field at connect", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect(fake.params.voiceFocus).toBe("near-field");
    await session.close();
  });

  test("respects an explicit voiceFocus and disables on 'off'", async () => {
    const far = await openSession({ model: "universal-3-5-pro", voiceFocus: "far-field" });
    expect(fakeOf(far).params.voiceFocus).toBe("far-field");
    await far.close();

    const off = await openSession({ model: "universal-3-5-pro", voiceFocus: "off" });
    const offFake = fakeOf(off);
    expect(offFake.params.voiceFocus).toBeUndefined();
    expect("voiceFocus" in offFake.params).toBe(false);
    await off.close();
  });

  test("sends voiceFocusThreshold, defaulting ABOVE the service's own 0.7", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    // The whole point of the default is that it is more aggressive than the
    // service's — inheriting 0.7 is the regression this pins.
    expect(fake.params.voiceFocusThreshold).toBe(DEFAULT_VOICE_FOCUS_THRESHOLD);
    expect(DEFAULT_VOICE_FOCUS_THRESHOLD).toBeGreaterThan(0.7);
    await session.close();
  });

  test("respects an explicit voiceFocusThreshold", async () => {
    const session = await openSession({ model: "universal-3-5-pro", voiceFocusThreshold: 0.5 });
    const fake = fakeOf(session);
    expect(fake.params.voiceFocusThreshold).toBe(0.5);
    await session.close();
  });

  test("omits the threshold when voice focus is off — it tunes a filter that isn't running", async () => {
    const off = await openSession({
      model: "universal-3-5-pro",
      voiceFocus: "off",
      voiceFocusThreshold: 0.9,
    });
    const fake = fakeOf(off);
    expect("voiceFocusThreshold" in fake.params).toBe(false);
    await off.close();
  });
});

describe("assemblyAIStt STT adapter — endpointing (min/max_turn_silence)", () => {
  test("always sets BOTH halves; defaults to the DEFAULT_*_TURN_SILENCE_MS pair", async () => {
    // Endpointing is the provider's job — the pipeline transport commits a
    // turn on every final. Both halves are sent because the service defaults
    // them independently (min from the `mode` preset, max to 1536), so sending
    // only one is how they end up inverted.
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(DEFAULT_MIN_TURN_SILENCE_MS);
    expect(fake.params.minTurnSilence).toBe(1600);
    expect(fake.params.maxTurnSilence).toBe(DEFAULT_MAX_TURN_SILENCE_MS);
    expect(fake.params.maxTurnSilence).toBe(3000);
    await session.close();
  });

  test("the default minimum stays BELOW the default maximum", () => {
    // The bug this pair replaced: min was raised 1500 -> 2000 -> 3000 to stop
    // utterances splitting, while max was never set and sat at the service
    // default 1536. Above 1536 the completeness check can no longer fire
    // before the content-blind force-end closes the turn, so every ending came
    // from the acoustic fallback — the very mechanism that splits utterances.
    // An inverted pair is silently wrong on the wire, so assert it here.
    expect(DEFAULT_MIN_TURN_SILENCE_MS).toBeLessThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("the speaking-edge idle deadline stays ABOVE the endpointing ceiling", () => {
    // The coupling the false-interruption rework made explicit. The idle
    // watchdog closing the speaking edge is what fires a false-interruption
    // resume, so an utterance force-ended by `max_turn_silence` must deliver
    // its final BEFORE that deadline — otherwise the agent resumes a reply the
    // caller really did interrupt. The transport cannot check this itself: it
    // receives an already-resolved SttOpener and never sees the endpointing
    // window. It used to be pinned only in prose, in the opposite direction
    // (max_turn_silence above the old 2000 ms recovery window), which is how
    // it stayed invisible. Note the margin covers final-emission latency, so
    // an agent raising maxTurnSilenceMs must raise `speechIdleTimeoutMs` too.
    expect(DEFAULT_SPEECH_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("each override is independent", async () => {
    const session = await openSession({
      model: "universal-3-5-pro",
      minTurnSilenceMs: 400,
      maxTurnSilenceMs: 5000,
    });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(400);
    expect(fake.params.maxTurnSilence).toBe(5000);
    await session.close();
  });

  test("overriding one leaves the other at its default", async () => {
    const session = await openSession({ model: "universal-3-5-pro", minTurnSilenceMs: 200 });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(200);
    expect(fake.params.maxTurnSilence).toBe(DEFAULT_MAX_TURN_SILENCE_MS);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — region (EU data residency)", () => {
  test("factory: region lands in the descriptor options and is absent by default", () => {
    expect(assemblyAIStt({ region: "eu" }).options.region).toBe("eu");
    expect("region" in assemblyAIStt().options).toBe(false);
  });

  test("region: 'eu' points the SDK's streaming socket at the EU endpoint", async () => {
    const session = await openSession({ model: "universal-3-5-pro", region: "eu" });
    const fake = fakeOf(session);
    expect(fake.params.websocketBaseUrl).toBe(ASSEMBLYAI_STREAMING_EU_URL);
    expect(fake.params.websocketBaseUrl).toBe("wss://streaming.eu.assemblyai.com/v3/ws");
    await session.close();
  });

  test("no region (or 'us') leaves the SDK's own default endpoint in place", async () => {
    // Not pinned host-side: a stale copy of the SDK's versioned default path
    // would silently override an SDK path bump.
    const unset = await openSession({ model: "universal-3-5-pro" });
    expect("websocketBaseUrl" in fakeOf(unset).params).toBe(false);
    await unset.close();

    const us = await openSession({ model: "universal-3-5-pro", region: "us" });
    expect("websocketBaseUrl" in fakeOf(us).params).toBe(false);
    await us.close();
  });

  test("languages sets language_codes, and is absent unless asked for", async () => {
    // Universal-3.5 Pro code-switches across 18 languages when this is unset,
    // so the absent case must stay absent — sending a default would silently
    // disable multilingual transcription for every agent.
    const unset = await openSession({ model: "universal-3-5-pro" });
    expect("languageCodes" in fakeOf(unset).params).toBe(false);
    await unset.close();

    const pinned = await openSession({ model: "universal-3-5-pro", languages: ["en"] });
    expect(fakeOf(pinned).params.languageCodes).toEqual(["en"]);
    await pinned.close();

    const several = await openSession({
      model: "universal-3-5-pro",
      languages: ["en", "es"],
    });
    expect(fakeOf(several).params.languageCodes).toEqual(["en", "es"]);
    await several.close();

    // An empty list is a no-op, not "pin zero languages".
    const empty = await openSession({ model: "universal-3-5-pro", languages: [] });
    expect("languageCodes" in fakeOf(empty).params).toBe(false);
    await empty.close();
  });

  test("streamingUrl overrides the endpoint, and wins over region", async () => {
    const sandbox = "wss://streaming.sandbox000.assemblyai-labs.com/v3/ws";

    const session = await openSession({ model: "universal-3-5-pro", streamingUrl: sandbox });
    expect(fakeOf(session).params.websocketBaseUrl).toBe(sandbox);
    await session.close();

    // An explicit endpoint is a deliberate choice; the residency shorthand
    // must not silently overwrite it.
    const both = await openSession({
      model: "universal-3-5-pro",
      region: "eu",
      streamingUrl: sandbox,
    });
    expect(fakeOf(both).params.websocketBaseUrl).toBe(sandbox);
    await both.close();
  });
});

describe("assemblyAIStt STT adapter — connect budget", () => {
  test("overrides the SDK's 1000 ms connect deadline and pins the retry policy", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);

    // The SDK default is 1000 ms for socket-open *plus* the server's `Begin`,
    // which a healthy connect can exceed; never inherit it.
    expect(fake.params.connectTimeout).toBe(STT_CONNECT_TIMEOUT_MS);
    expect(fake.params.connectTimeout).not.toBe(1000);
    expect(fake.params.maxConnectionRetries).toBe(STT_CONNECT_MAX_RETRIES);
    expect(fake.params.connectionRetryDelay).toBe(STT_CONNECT_RETRY_DELAY_MS);

    await session.close();
  });

  test("worst-case connect budget fits inside the session-start deadline", () => {
    // The STT open runs inside session.start(); a larger budget could only
    // surface as the less specific "session.start() timed out".
    const attempts = STT_CONNECT_MAX_RETRIES + 1;
    const worstCaseMs =
      attempts * STT_CONNECT_TIMEOUT_MS + STT_CONNECT_MAX_RETRIES * STT_CONNECT_RETRY_DELAY_MS;
    expect(worstCaseMs).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  test("forwards explicit connect overrides, including 0 to disable", async () => {
    const slow = await openSession({ connectTimeoutMs: 9000, maxConnectRetries: 0 });
    const slowFake = fakeOf(slow);
    expect(slowFake.params.connectTimeout).toBe(9000);
    expect(slowFake.params.maxConnectionRetries).toBe(0);
    await slow.close();

    // 0 is the SDK's "no deadline" value — it must survive as 0, not fall
    // back to the default via `??`-on-falsy.
    const unbounded = await openSession({ connectTimeoutMs: 0 });
    expect(fakeOf(unbounded).params.connectTimeout).toBe(0);
    await unbounded.close();
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
