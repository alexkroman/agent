// Copyright 2025 the AAI authors. MIT license.

/**
 * S2S fixture replay: a mock `S2sHandle`, the recorded wire fixtures, and a
 * real runtime session whose S2S transport seam is spied.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { vi } from "vitest";
import { makeTrackingClient } from "./_session-test-utils.ts";
import { silentLogger } from "./logger.ts";
import { createRuntimeWithSeams } from "./runtime/index.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle } from "./s2s/index.ts";
import { _internals as s2sTransportInternals } from "./transports/s2s-transport.ts";

/** Create a mock S2sHandle backed by vi.fn() spies. */
export function makeMockHandle(): S2sHandle {
  return {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    updateSession: vi.fn(),
    resumeSession: vi.fn(),
    close: vi.fn(),
  };
}

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

/** Load a JSON fixture from fixtures/. */
export function loadFixture<T = Record<string, unknown>[]>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf-8"));
}

/** Translate one fixture wire-format message into the matching S2sCallbacks call. */
export function fireFixtureMessage(callbacks: S2sCallbacks, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "session.ready":
      callbacks.onSessionReady(msg.session_id as string);
      break;
    case "session.updated":
      break; // no callback
    case "reply.started":
      callbacks.onReplyStarted(msg.reply_id as string);
      break;
    case "reply.done":
      if (msg.status === "interrupted") callbacks.onCancelled();
      else callbacks.onReplyDone();
      break;
    case "transcript.user":
      callbacks.onUserTranscript(msg.text as string);
      break;
    case "transcript.agent":
      callbacks.onAgentTranscript(msg.text as string, Boolean(msg.interrupted));
      break;
    case "tool.call":
      callbacks.onToolCall(
        msg.call_id as string,
        msg.name as string,
        (msg.args ?? {}) as Record<string, unknown>,
      );
      break;
    case "input.speech.started":
      callbacks.onSpeechStarted();
      break;
    case "input.speech.stopped":
      callbacks.onSpeechStopped();
      break;
    case "session.error": {
      const code = msg.code as string;
      if (code === "session_not_found" || code === "session_forbidden")
        callbacks.onSessionExpired();
      else callbacks.onError(new Error((msg.message ?? "session error") as string));
      break;
    }
    case "error":
      callbacks.onError(new Error((msg.message ?? "error") as string));
      break;
    case "reply.audio":
      break; // skip — audio tested separately
    default:
      break;
  }
}

/**
 * Create a real Runtime-backed session for fixture replay testing.
 *
 * Spies on s2s-transport.ts `_internals.connectS2s` so the captured
 * S2sCallbacks can be fired directly. Call `await ctx.start()` first to trigger
 * the spy, then `ctx.replay(name)` or fire `ctx.mockCallbacks.on*`. The spy is
 * restored by `restoreMocks`.
 */
export function createFixtureSession(agent: AgentDef, options?: { env?: Record<string, string> }) {
  let capturedCallbacks: S2sCallbacks | null = null;
  const fakeHandle = makeMockHandle();

  // No teardown to return: vitest's `restoreMocks` restores every spy before
  // each test (see vitest.shared.ts).
  vi.spyOn(s2sTransportInternals, "connectS2s").mockImplementation(
    async (connectOpts: ConnectS2sOptions) => {
      capturedCallbacks = connectOpts.callbacks;
      return fakeHandle;
    },
  );

  const client = makeTrackingClient();
  const executor = createRuntimeWithSeams({
    // This helper replays the AssemblyAI S2S protocol (it spies the S2S
    // transport seam), so pin the agent to S2S mode — the descriptor the
    // pipeline-by-default flip requires — unless it declared providers.
    agent:
      agent.stt != null || agent.llm != null || agent.tts != null || agent.s2s != null
        ? agent
        : { ...agent, mode: "s2s", s2s: assemblyAIS2s() },
    env: options?.env ?? {},
    logger: silentLogger,
  });

  const session = executor.createSession({
    id: "fixture-session",
    agent: agent.name,
    client,
  });

  function getCallbacks(): S2sCallbacks {
    if (!capturedCallbacks) throw new Error("must call start() before accessing callbacks");
    return capturedCallbacks;
  }

  return {
    session,
    client,
    fakeHandle,
    executor,
    /** Trigger transport.start() — fires the connectS2s spy and captures callbacks. */
    async start() {
      await session.start();
      if (!capturedCallbacks) throw new Error("connectS2s was never called during start()");
    },
    /** Direct access to the captured S2sCallbacks for manual event firing. */
    get mockCallbacks(): S2sCallbacks {
      return getCallbacks();
    },
    /** Replay a fixture file by translating each message to S2sCallbacks calls. */
    replay(fixtureName: string) {
      const cbs = getCallbacks();
      for (const msg of loadFixture(fixtureName)) {
        fireFixtureMessage(cbs, msg as Record<string, unknown>);
      }
    },
  };
}
