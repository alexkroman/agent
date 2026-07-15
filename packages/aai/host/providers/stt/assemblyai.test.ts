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
      sendAudio(_data: ArrayBufferLike) {
        /* no-op */
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
    const errors: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));
    session.on("error", (e) => errors.push(e.message));

    const fake = session._transcriber as unknown as FakeTranscriber;
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
