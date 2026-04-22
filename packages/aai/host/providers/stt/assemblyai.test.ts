// Copyright 2025 the AAI authors. MIT license.
/** Fixture-replay unit test for the AssemblyAI STT adapter. */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent } from "assemblyai";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { type AssemblyAISession, assemblyAI } from "./assemblyai.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mock the `assemblyai` SDK so no real sockets are opened.
//
// Each fake `StreamingTranscriber` keeps its own listener map and exposes
// `_fire(event, payload)` for tests to inject events. The adapter's
// `open()` returns an `AssemblyAISession` with a `_transcriber` pointer,
// which in the test is the fake — giving the test a handle to `_fire`.
// ---------------------------------------------------------------------------

interface FakeTranscriber {
  on(ev: string, fn: (...args: unknown[]) => void): void;
  connect(): Promise<void>;
  close(): Promise<void>;
  sendAudio(_data: ArrayBufferLike): void;
  _fire(ev: string, ...args: unknown[]): void;
}

vi.mock("assemblyai", () => {
  const makeFakeTranscriber = (): FakeTranscriber => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
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
      _fire(ev, ...args) {
        for (const fn of listeners.get(ev) ?? []) fn(...args);
      },
    };
  };
  return {
    AssemblyAI: class {
      streaming = {
        transcriber: (_params: unknown): FakeTranscriber => makeFakeTranscriber(),
      };
    },
  };
});

describe("assemblyAI STT adapter — fixture replay", () => {
  test("maps turn events onto partial/final SttEvents", async () => {
    const fixture = JSON.parse(
      await readFile(join(here, "fixtures/assemblyai/basic-turn.json"), "utf8"),
    ) as Record<string, unknown>[];

    const provider = assemblyAI({ model: "u3pro-rt", apiKey: "k" });
    const controller = new AbortController();
    const session = (await provider.open({
      sampleRate: 16_000,
      apiKey: "k",
      signal: controller.signal,
    })) as AssemblyAISession;

    const partials: string[] = [];
    const finals: string[] = [];
    const errors: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));
    session.on("error", (e) => errors.push(e.message));

    // Replay fixture through the fake transcriber. The JSON's "type" field
    // distinguishes Begin from Turn; we only dispatch turn messages since
    // Begin is consumed inside `connect()` by the real SDK.
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
