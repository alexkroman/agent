// Copyright 2026 the AAI authors. MIT license.
// End-to-end channel test: a fake eve peer drives the real protocol handler,
// pipeline transport, and eve turn runner against fake STT/TTS providers and
// a scripted eve session — no network, no LLM.

import {
  registerSttKind,
  registerTtsKind,
  type SttOpener,
  type SttSession,
  type TtsOpener,
  type TtsSession,
  type Unsubscribe,
} from "@alexkroman1/aai/runtime";
import type { WebSocketPeer, WebSocketRouteHooks } from "eve/channels";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { VoiceRouteArgsLike, VoiceSessionLike } from "./route-agent-handle.ts";
import { voiceChannel } from "./voice-channel.ts";

// ─── Fake providers, registered as real provider kinds ─────────────────────

const sttSessions: FakeSttSession[] = [];
const ttsSessions: FakeTtsSession[] = [];

type FakeSttSession = SttSession & { fireFinal(text: string): void };
type FakeTtsSession = TtsSession & { readonly sent: string[] };

function openFakeStt(): FakeSttSession {
  const finals: ((text: string) => void)[] = [];
  const session: FakeSttSession = {
    sendAudio: () => undefined,
    on: (event, fn): Unsubscribe => {
      if (event === "final") finals.push(fn as (text: string) => void);
      return () => undefined;
    },
    close: async () => undefined,
    fireFinal: (text) => {
      for (const fn of finals) fn(text);
    },
  };
  sttSessions.push(session);
  return session;
}

function openFakeTts(): FakeTtsSession {
  const sent: string[] = [];
  const audio: ((pcm: Int16Array) => void)[] = [];
  const done: (() => void)[] = [];
  const session: FakeTtsSession = {
    sent,
    sendText: (text) => {
      sent.push(text);
      for (const fn of audio) fn(new Int16Array(160));
    },
    flush: () => {
      for (const fn of done) fn();
    },
    cancel: () => undefined,
    on: (event, fn): Unsubscribe => {
      if (event === "audio") audio.push(fn as (pcm: Int16Array) => void);
      if (event === "done") done.push(fn as () => void);
      return () => undefined;
    },
    close: async () => undefined,
  };
  ttsSessions.push(session);
  return session;
}

const sttOpener: SttOpener = { name: "fake-stt", open: async () => openFakeStt() };
const ttsOpener: TtsOpener = { name: "fake-tts", open: async () => openFakeTts() };
const unregister = [
  registerSttKind("eve-test-stt", { envVar: "FAKE_STT_KEY", open: () => sttOpener }),
  registerTtsKind("eve-test-tts", { envVar: "FAKE_TTS_KEY", open: () => ttsOpener }),
];
afterAll(() => {
  for (const off of unregister) off();
});

// ─── Scripted eve session ───────────────────────────────────────────────────

/** Every send() yields one scripted reply turn on the event stream. */
function fakeRouteArgs(replyText: string): VoiceRouteArgsLike & { send: ReturnType<typeof vi.fn> } {
  let turn = 0;
  const session: VoiceSessionLike = {
    id: "es-1",
    continuationToken: "tok",
    cancel: async () => ({ status: "accepted" }),
    getEventStream: async () => {
      turn += 1;
      const turnId = `t${turn}`;
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "turn.started", data: { turnId } });
          controller.enqueue({
            type: "message.appended",
            data: { messageDelta: replyText, turnId },
          });
          controller.enqueue({ type: "message.completed", data: { message: replyText, turnId } });
          controller.enqueue({ type: "turn.completed", data: { turnId } });
          controller.enqueue({
            type: "session.waiting",
            data: { continuationToken: "tok-next", wait: "next-user-message" },
          });
          controller.close();
        },
      });
    },
  };
  return { send: vi.fn(async () => session), getSession: () => session };
}

// ─── Fake peer ──────────────────────────────────────────────────────────────

function fakePeer(): {
  peer: WebSocketPeer;
  jsonFrames: () => Record<string, unknown>[];
  binaryFrames: () => Uint8Array[];
} {
  const sent: unknown[] = [];
  const peer = {
    id: "peer-1",
    send: (data: unknown) => {
      sent.push(data);
    },
    close: () => undefined,
  } as unknown as WebSocketPeer;
  return {
    peer,
    jsonFrames: () =>
      sent
        .filter((f): f is string => typeof f === "string")
        .map((f) => JSON.parse(f) as Record<string, unknown>),
    binaryFrames: () => sent.filter((f): f is Uint8Array => f instanceof Uint8Array),
  };
}

const noop = (): void => undefined;
const silentLogger = { debug: noop, info: noop, warn: noop, error: noop };

function makeChannel(routeArgsReply: string) {
  const routeArgs = fakeRouteArgs(routeArgsReply);
  const channel = voiceChannel({
    stt: { kind: "eve-test-stt", options: {} },
    tts: { kind: "eve-test-tts", options: {} },
    env: { FAKE_STT_KEY: "sk", FAKE_TTS_KEY: "tk" },
    endpointSettleMs: 0,
    holdPhrase: "",
    logger: silentLogger,
  });
  const route = channel.routes[0];
  if (route?.transport !== "websocket") throw new Error("expected a websocket route");
  return { channel, route, routeArgs };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("voiceChannel", () => {
  test("declares one WebSocket route at the aai client's default path", () => {
    const { route } = makeChannel("x");
    expect(route.path).toBe("/websocket");
    expect(route.method).toBe("WEBSOCKET");
  });

  test("a connection gets the config frame, and a user turn speaks the eve reply", async () => {
    const { route, routeArgs } = makeChannel("Hello from the eve agent.");
    const hooks = (await route.handler(
      new Request("http://localhost/websocket"),
      routeArgs as unknown as Parameters<typeof route.handler>[1],
    )) as WebSocketRouteHooks;

    const { peer, jsonFrames, binaryFrames } = fakePeer();
    await hooks.open?.(peer);

    // Protocol config frame arrives on connect.
    await vi.waitFor(() => {
      expect(jsonFrames().some((f) => f.type === "config")).toBe(true);
    });
    const config = jsonFrames().find((f) => f.type === "config");
    expect(config).toMatchObject({ audioFormat: "pcm16", sampleRate: 16_000 });

    // A committed user utterance goes into eve and the reply is spoken.
    await vi.waitFor(() => expect(sttSessions.length).toBeGreaterThan(0));
    sttSessions.at(-1)?.fireFinal("what can you do");

    await vi.waitFor(() => {
      expect(routeArgs.send).toHaveBeenCalled();
    });
    expect(routeArgs.send.mock.calls[0]?.[0]).toEqual({ message: "what can you do" });

    // The eve reply reached TTS and its audio reached the peer as binary.
    await vi.waitFor(() => {
      expect(ttsSessions.at(-1)?.sent.join("")).toContain("Hello from the eve agent.");
    });
    await vi.waitFor(() => expect(binaryFrames().length).toBeGreaterThan(0));

    // And the transcript event reached the client as JSON.
    await vi.waitFor(() => {
      expect(
        jsonFrames().some((f) => JSON.stringify(f).includes("Hello from the eve agent.")),
      ).toBe(true);
    });

    await hooks.close?.(peer, {});
  });
});
