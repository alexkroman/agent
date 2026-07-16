// Copyright 2025 the AAI authors. MIT license.
/** Fixture-replay unit test for the AssemblyAI STT adapter. */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent } from "assemblyai";
import { describe, expect, test, vi } from "vitest";
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

describe("assemblyAI STT adapter — fixture replay", () => {
  test("maps turn events onto partial/final SttEvents", async () => {
    const fixture = JSON.parse(
      await readFile(join(here, "fixtures/assemblyai/basic-turn.json"), "utf8"),
    ) as Record<string, unknown>[];

    const session = await openSession({ model: "u3pro-rt" });

    const partials: string[] = [];
    const finals: string[] = [];
    const confidences: (number | undefined)[] = [];
    const errors: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t, endOfTurnConfidence) => {
      finals.push(t);
      confidences.push(endOfTurnConfidence);
    });
    session.on("error", (e) => errors.push(e.message));

    const fake = session._transcriber as unknown as FakeTranscriber;
    for (const msg of fixture) {
      if (msg.type === "Turn") fake._fire("turn", msg as TurnEvent);
    }

    await flush();

    expect(partials).toEqual(["what", "what's the"]);
    expect(finals).toEqual(["what's the weather?"]);
    // The endpointing model's boundary score rides along on finals.
    expect(confidences).toEqual([0.95]);
    expect(errors).toEqual([]);

    await session.close();
  });
});

describe("assemblyAI STT adapter — agent_context (Universal-3.5 Pro only)", () => {
  test("universal-3-5-pro: passes agentContext at connect and updates it mid-stream", async () => {
    const session = await openSession(
      { model: "universal-3-5-pro" },
      { agentContext: "Hi, how can I help you today?" },
    );
    const fake = session._transcriber as unknown as FakeTranscriber;

    expect(fake.params.agentContext).toBe("Hi, how can I help you today?");

    session.updateAgentContext?.("Sure, I can help with that.");
    expect(fake.updateConfigurationCalls).toEqual([
      { agent_context: "Sure, I can help with that." },
    ]);

    await session.close();
  });

  test("universal-3-5-pro (u3pro-rt alias): trims agentContext to 1750 chars, both at connect and mid-stream", async () => {
    const long = "x".repeat(2000);
    const trimmed = "x".repeat(1750);

    const session = await openSession({ model: "u3pro-rt" }, { agentContext: long });
    const fake = session._transcriber as unknown as FakeTranscriber;

    expect(fake.params.agentContext).toBe(trimmed);

    session.updateAgentContext?.(long);
    expect(fake.updateConfigurationCalls).toEqual([{ agent_context: trimmed }]);

    await session.close();
  });

  test("universal-3-5-pro: skips empty/whitespace-only agentContext, both at connect and mid-stream", async () => {
    const session = await openSession({ model: "universal-3-5-pro" }, { agentContext: "   " });
    const fake = session._transcriber as unknown as FakeTranscriber;

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
    const fake = session._transcriber as unknown as FakeTranscriber;

    expect(fake.params.agentContext).toBeUndefined();
    expect("agentContext" in fake.params).toBe(false);

    session.updateAgentContext?.("Sure, I can help with that.");
    expect(fake.updateConfigurationCalls).toEqual([]);

    await session.close();
  });
});

describe("assemblyAI STT adapter — voice focus", () => {
  test("defaults voiceFocus to near-field at connect", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = session._transcriber as unknown as FakeTranscriber;
    expect(fake.params.voiceFocus).toBe("near-field");
    await session.close();
  });

  test("respects an explicit voiceFocus and disables on 'off'", async () => {
    const far = await openSession({ model: "universal-3-5-pro", voiceFocus: "far-field" });
    expect((far._transcriber as unknown as FakeTranscriber).params.voiceFocus).toBe("far-field");
    await far.close();

    const off = await openSession({ model: "universal-3-5-pro", voiceFocus: "off" });
    const offFake = off._transcriber as unknown as FakeTranscriber;
    expect(offFake.params.voiceFocus).toBeUndefined();
    expect("voiceFocus" in offFake.params).toBe(false);
    await off.close();
  });
});

describe("assemblyAI STT adapter — frame coalescing (50–1000 ms)", () => {
  // At 16 kHz mono PCM16: 20 ms = 320 samples, 50 ms = 800, 100 ms = 1600,
  // 1000 ms = 16000. AssemblyAI streaming rejects frames outside [50, 1000] ms.
  const SAMPLES_20MS = 320;
  const SAMPLES_100MS = 1600;
  const SAMPLES_1000MS = 16_000;

  test("buffers sub-100 ms frames and forwards one ~100 ms frame once accumulated", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = session._transcriber as unknown as FakeTranscriber;

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
    const fake = session._transcriber as unknown as FakeTranscriber;

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
    const fake = session._transcriber as unknown as FakeTranscriber;

    session.sendAudio(new Int16Array(SAMPLES_20MS)); // 20 ms, held below 100 ms
    expect(fake.sentAudio.length).toBe(0);

    await session.close(); // 20 ms < 50 ms floor → dropped, not forwarded
    expect(fake.sentAudio.length).toBe(0);
  });
});
