// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline fuzz's action table: each generated step does what a real
 * session's provider or client would, and nothing a provider may not — no TTS
 * audio outside a turn's synthesis window, no reset in a long session.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createFakeSttProvider,
  createFakeTtsProvider,
  type FakeSttProvider,
  type FakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { PIPELINE_CAPABILITIES } from "../transports/capabilities.ts";
import type { Transport } from "../transports/types.ts";
import { buildActions } from "./_pipeline-fuzz-actions.ts";
import type { Monitor } from "./_pipeline-fuzz-model.ts";

const OPEN = { sampleRate: 16_000, apiKey: "k", signal: new AbortController().signal };

function monitor(): Monitor & { hits: string[]; disturbed: number } {
  const mon: Monitor & { hits: string[]; disturbed: number } = {
    hits: [],
    disturbed: 0,
    current: null,
    stopped: false,
    declaredDead: null,
    toolInFlight: 0,
    audioTotal: 0,
    liveStreams: 0,
    maxLiveStreams: 0,
    consumedSteps: 0,
    speculating: false,
    ttsAccountedFor: null,
    flag: (what) => {
      throw new Error(what);
    },
    hit: (key) => mon.hits.push(key),
    disturb: () => {
      mon.disturbed++;
    },
  };
  return mon;
}

function fakeTransport() {
  return {
    capabilities: PIPELINE_CAPABILITIES,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
    reset: vi.fn(),
  } satisfies Transport;
}

async function setup(options: { longSession?: boolean; pauseWasNull?: boolean } = {}) {
  const stt: FakeSttProvider = createFakeSttProvider();
  const tts: FakeTtsProvider = createFakeTtsProvider();
  await stt.open(OPEN);
  await tts.open(OPEN);
  const mon = monitor();
  const transport = fakeTransport();
  const speculated: { text: string | null } = { text: null };
  const armBargeInFromTool = vi.fn();
  const actions = buildActions(mon, {
    stt,
    tts,
    transport,
    utterance: (opener) => `utterance ${opener}`,
    longSession: options.longSession ?? false,
    armBargeInFromTool,
    speculated,
    lastPauseWasNull: () => options.pauseWasNull ?? false,
  });
  const partials: string[] = [];
  const finals: string[] = [];
  stt.last()?.on("partial", (text) => partials.push(text));
  stt.last()?.on("final", (text) => finals.push(text));
  const audio = vi.fn();
  tts.last()?.on("audio", audio);
  return { mon, transport, speculated, armBargeInFromTool, actions, partials, finals, audio };
}

function liveReply(mon: Monitor): void {
  mon.current = {
    id: "r1",
    ttsOffset: 0,
    expected: "",
    disturbed: false,
    audioChunks: 0,
    failed: false,
    done: false,
  };
}

describe("buildActions", () => {
  test("STT steps fire the opener's utterance", async () => {
    const { actions, partials, finals } = await setup();
    actions.sttPartial(1);
    actions.sttFinal(2);
    expect(partials).toEqual(["utterance 1"]);
    expect(finals).toEqual(["utterance 2"]);
  });

  test("a confident partial with a pause is handed to the next final, so it matches", async () => {
    const { actions, speculated, finals } = await setup({ pauseWasNull: false });
    actions.highConfidencePartial(3);
    expect(speculated.text).toBe("utterance 3");
    expect(finals).toEqual([]);
    actions.sttFinal(0);
    expect(finals).toEqual(["utterance 3"]);
    expect(speculated.text).toBeNull();
  });

  test("a confident partial with no pause commits at once", async () => {
    const { actions, finals } = await setup({ pauseWasNull: true });
    actions.highConfidencePartial(0);
    expect(finals).toEqual(["utterance 0"]);
  });

  test("TTS audio is suppressed outside a live reply, and emitted inside one", async () => {
    const { actions, mon, audio } = await setup();
    actions.ttsAudio(0);
    expect(mon.hits).toEqual(["audioSuppressedOutsideTurn"]);
    expect(audio).not.toHaveBeenCalled();
    liveReply(mon);
    actions.ttsAudio(0);
    expect(audio).toHaveBeenCalledTimes(1);
  });

  test("a noise barge-in speaks only while a reply is live, then fires a noise partial", async () => {
    const { actions, mon, audio, partials } = await setup();
    actions.noiseBargeIn(0);
    expect(audio).not.toHaveBeenCalled();
    liveReply(mon);
    actions.noiseBargeIn(0);
    expect(audio).toHaveBeenCalledTimes(1);
    expect(partials).toEqual(["uh what", "uh what"]);
  });

  test("cancel and reset disturb the reply first; reset is skipped in a long session", async () => {
    const short = await setup();
    short.actions.cancelReply(0);
    short.actions.reset(0);
    expect(short.mon.disturbed).toBe(2);
    expect(short.transport.cancelReply).toHaveBeenCalledTimes(1);
    expect(short.transport.reset).toHaveBeenCalledTimes(1);

    const long = await setup({ longSession: true });
    long.actions.reset(0);
    expect(long.mon.disturbed).toBe(0);
    expect(long.transport.reset).not.toHaveBeenCalled();
  });

  test("client audio and the tool barge-in go straight to their collaborators", async () => {
    const { actions, transport, armBargeInFromTool } = await setup();
    actions.sendUserAudio(0);
    actions.armBargeInFromTool(0);
    expect(transport.sendUserAudio).toHaveBeenCalledWith(new Uint8Array(320));
    expect(armBargeInFromTool).toHaveBeenCalledTimes(1);
  });
});
