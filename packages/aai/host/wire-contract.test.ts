// Copyright 2026 the AAI authors. MIT license.
// Cross-package contract test: an encoded client→server frame decoded by the
// server reaches the right SessionCore method; a server→client response
// encoded by the ClientSink decodes to the expected DecodedS2C variant.

import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../sdk/protocol.ts";
import {
  decodeC2S,
  decodeS2C,
  encAudioChunkC2S,
  encConfig,
  encReplyDone,
  encUserTranscript,
  S2C,
} from "../sdk/wire.ts";
import type { SessionCoreOptions } from "./session-core.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";

function makeSink(): { frames: Uint8Array[]; sink: ClientSink } {
  const frames: Uint8Array[] = [];
  const sink: ClientSink = {
    get open() {
      return true;
    },
    config: (cfg) => frames.push(encConfig(cfg)),
    audio: vi.fn(),
    audioDone: () => frames.push(new Uint8Array([S2C.AUDIO_DONE])),
    speechStarted: vi.fn(),
    speechStopped: vi.fn(),
    userTranscript: (text) => frames.push(encUserTranscript(text)),
    agentTranscript: vi.fn(),
    toolCall: vi.fn(),
    toolCallDone: vi.fn(),
    replyDone: () => frames.push(encReplyDone()),
    cancelled: vi.fn(),
    reset: vi.fn(),
    idleTimeout: vi.fn(),
    error: vi.fn(),
    customEvent: vi.fn(),
  };
  return { frames, sink };
}

function makeTransport(): Transport {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

describe("wire contract: client encode → server decode → session method", () => {
  test("AUDIO_CHUNK reaches session.onAudio", async () => {
    const transport = makeTransport();
    const { sink } = makeSink();
    const core = createSessionCore({
      id: "s1",
      agent: "a",
      client: sink,
      agentConfig: {
        name: "a",
        systemPrompt: "x",
        greeting: "",
      } as unknown as SessionCoreOptions["agentConfig"],
      executeTool: vi.fn(async () => "ok"),
      transport,
    });
    await core.start();

    const frame = encAudioChunkC2S(new Uint8Array([1, 2, 3]));
    const decoded = decodeC2S(frame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.data.type === "audio_chunk") {
      core.onAudio(decoded.data.pcm);
      expect(vi.mocked(transport.sendUserAudio)).toHaveBeenCalledWith(decoded.data.pcm);
    }
    await core.stop();
  });
});

describe("wire contract: server sink → client decode", () => {
  test("REPLY_DONE encoded by sink decodes to { type: 'reply_done' }", () => {
    const { frames, sink } = makeSink();
    sink.replyDone();
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (!frame) throw new Error("expected a frame");
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.type).toBe("reply_done");
  });

  test("USER_TRANSCRIPT round-trips multi-byte UTF-8", () => {
    const { frames, sink } = makeSink();
    sink.userTranscript("café");
    const frame = frames[0];
    if (!frame) throw new Error("expected a frame");
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "user_transcript") {
      expect(r.data.text).toBe("café");
    }
  });

  test("CONFIG round-trips sampleRate/ttsSampleRate/sid", () => {
    const { frames, sink } = makeSink();
    sink.config({ sampleRate: 16_000, ttsSampleRate: 24_000, sid: "session-42" });
    const frame = frames[0];
    if (!frame) throw new Error("expected a frame");
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "config") {
      expect(r.data.sampleRate).toBe(16_000);
      expect(r.data.ttsSampleRate).toBe(24_000);
      expect(r.data.sid).toBe("session-42");
    }
  });
});
