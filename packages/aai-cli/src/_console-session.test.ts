// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import {
  type ConsolePlayer,
  type ConsolePrinter,
  createConsoleSink,
  createSampleAligner,
} from "./_console-session.ts";

function ev(body: SessionEventBody): SessionEvent {
  return { ...body, meta: { id: "e", at: 0 } } as SessionEvent;
}

function setup() {
  const player: ConsolePlayer = { write: vi.fn(), flush: vi.fn(), stop: vi.fn() };
  const print: ConsolePrinter = {
    user: vi.fn(),
    agent: vi.fn(),
    tool: vi.fn(),
    error: vi.fn(),
  };
  const onClosed = vi.fn();
  const onFatal = vi.fn();
  const sink = createConsoleSink({ player, print, onClosed, onFatal });
  return { sink, player, print, onClosed, onFatal };
}

describe("createConsoleSink", () => {
  test("agent audio goes to the speaker", () => {
    const { sink, player } = setup();
    const chunk = new Uint8Array([1, 2, 3, 4]);
    sink.playAudioChunk(chunk);
    expect(player.write).toHaveBeenCalledWith(chunk);
  });

  test("committed transcripts are printed; interim ones are not", () => {
    const { sink, print } = setup();
    sink.event(ev({ type: "user-transcript.committed", text: "What time is it?" }));
    sink.event(ev({ type: "agent-transcript.updated", text: "It is" }));
    sink.event(ev({ type: "agent-transcript.committed", text: "It is noon." }));

    expect(print.user).toHaveBeenCalledWith("What time is it?");
    expect(print.agent).toHaveBeenCalledTimes(1);
    expect(print.agent).toHaveBeenCalledWith("It is noon.");
  });

  test("a barge-in flushes the speaker and prints what was said so far as interrupted", () => {
    const { sink, player, print } = setup();
    sink.event(ev({ type: "agent-transcript.updated", text: "Let me tell you about" }));
    sink.event(ev({ type: "reply.cancelled" }));

    expect(player.flush).toHaveBeenCalledTimes(1);
    expect(print.agent).toHaveBeenCalledWith("Let me tell you about", true);
  });

  test("a reset flushes the speaker without printing a reply", () => {
    const { sink, player, print } = setup();
    sink.event(ev({ type: "agent-transcript.updated", text: "Half a sentence" }));
    sink.event(ev({ type: "session.reset" }));
    sink.event(ev({ type: "reply.cancelled" }));

    expect(player.flush).toHaveBeenCalledTimes(2);
    expect(print.agent).not.toHaveBeenCalled();
  });

  test("tool calls and errors are printed, and only a FATAL error ends the console", () => {
    const { sink, print, onFatal } = setup();
    sink.event(ev({ type: "error.reported", code: "llm", message: "one turn", fatal: false }));
    expect(onFatal).not.toHaveBeenCalled();
    sink.event(ev({ type: "tool.called", toolCallId: "t1", toolName: "lookup", args: { id: 7 } }));
    sink.event(ev({ type: "error.reported", code: "tts", message: "no key", fatal: true }));

    expect(print.tool).toHaveBeenCalledWith("lookup", { id: 7 });
    expect(print.error).toHaveBeenCalledWith("no key", true);
    expect(onFatal).toHaveBeenCalledWith("no key");
  });

  test("close reports once and marks the sink closed", () => {
    const { sink, onClosed } = setup();
    expect(sink.open).toBe(true);
    sink.close?.("session start failed");
    sink.close?.("again");
    expect(sink.open).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith("session start failed");
  });
});

describe("createSampleAligner", () => {
  test("never splits a PCM16 sample across two chunks", () => {
    const sendAudio = vi.fn();
    const feed = createSampleAligner({ sendAudio });

    feed(new Uint8Array([1, 2, 3]));
    feed(new Uint8Array([4, 5]));
    feed(new Uint8Array([6]));
    feed(new Uint8Array(0));

    const sent = sendAudio.mock.calls.map(([b]) => [...(b as Uint8Array)]);
    expect(sent).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    for (const [bytes] of sendAudio.mock.calls) {
      expect((bytes as Uint8Array).byteLength % 2).toBe(0);
    }
  });
});
