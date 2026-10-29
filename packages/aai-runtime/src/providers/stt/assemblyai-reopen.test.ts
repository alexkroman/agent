// Copyright 2026 the AAI authors. MIT license.
/**
 * A deaf AssemblyAI socket is replaced mid-session (`_stt-liveness.ts`): voiced
 * audio with no turn event opens a fresh socket, which first hears the recent
 * audio the old one never answered; the old one drains, its last turn still
 * counts, and its close does not end the session.
 */
import type { StreamingTranscriberParams, TurnEvent } from "assemblyai";
import { describe, expect, test } from "vitest";
import { tick } from "../../_timing-test-utils.ts";
import { FakeTranscriber } from "./_assemblyai-test-utils.ts";
import { STT_DEAF_VOICED_MS } from "./_stt-liveness.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

const SR = 16_000;
function frame(ms: number, amp: number): Int16Array {
  const out = new Int16Array((SR * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

async function open() {
  const sockets: FakeTranscriber[] = [];
  const session = (await openAssemblyAI(
    { model: "u3pro-rt" },
    (_key, params: StreamingTranscriberParams) => {
      const t = new FakeTranscriber(params);
      sockets.push(t);
      return t;
    },
  ).open({
    sampleRate: SR,
    apiKey: "k",
    signal: new AbortController().signal,
  })) as AssemblyAISession;
  const finals: string[] = [];
  const errors: unknown[] = [];
  session.on("final", (text) => finals.push(text));
  session.on("error", (err) => errors.push(err));
  return { session, sockets, finals, errors };
}

/** Background, then speech the socket never answers. */
function speakUnheard(session: AssemblyAISession, ms: number): void {
  for (let t = 0; t < 1000; t += 100) session.sendAudio(frame(100, 330));
  for (let t = 0; t < ms; t += 100) session.sendAudio(frame(100, 6000));
}

describe("AssemblyAI STT: reopening a deaf socket", () => {
  test("voiced audio with no turn event opens a fresh socket and replays the recent audio to it", async () => {
    const { session, sockets, errors } = await open();
    speakUnheard(session, STT_DEAF_VOICED_MS);
    await tick();
    expect(sockets).toHaveLength(2);
    const [old, fresh] = sockets;
    expect(old?.close).toHaveBeenCalled();
    // Replayed audio, then the live audio after it, all on the new socket.
    expect(fresh?.sendAudio.mock.calls.length).toBeGreaterThan(0);
    const sentBytes = fresh?.sentAudio.reduce((n, b) => n + b.byteLength, 0) ?? 0;
    expect(sentBytes).toBeGreaterThanOrEqual(2 * SR * 2.5); // ≥ 2.5 s of PCM16
    expect(errors).toEqual([]);
    await session.close();
  });

  test("a socket that answers is never replaced", async () => {
    const { session, sockets } = await open();
    for (let t = 0; t < 10_000; t += 500) {
      speakUnheard(session, 400);
      sockets[0]?._fire("turn", { transcript: "still here", end_of_turn: false } as TurnEvent);
    }
    await tick();
    expect(sockets).toHaveLength(1);
    await session.close();
  });

  test("the old socket's last turn still counts while it drains; its close does not end the session", async () => {
    const { session, sockets, finals, errors } = await open();
    // The SDK's close waits for the service's Termination, which comes after
    // the flushed turn; hold it open until the test has fired that turn.
    let terminated = (): void => undefined;
    sockets[0]?.close.mockImplementation(
      () =>
        new Promise<undefined>((r) => {
          terminated = () => r(undefined);
        }),
    );
    speakUnheard(session, STT_DEAF_VOICED_MS);
    await tick();
    const [old, fresh] = sockets;
    old?._fire("turn", {
      transcript: "my name is Lucas",
      end_of_turn: true,
      turn_is_formatted: true,
    } as TurnEvent);
    old?._fire("close", 1000, "");
    terminated();
    await tick();
    old?._fire("turn", {
      transcript: "too late",
      end_of_turn: true,
      turn_is_formatted: true,
    } as TurnEvent);
    fresh?._fire("turn", {
      transcript: "and the zip is 80239",
      end_of_turn: true,
      turn_is_formatted: true,
    } as TurnEvent);
    await tick();
    expect(finals).toEqual(["my name is Lucas", "and the zip is 80239"]);
    expect(errors).toEqual([]);
    await session.close();
  });

  test("the new socket gets the session's live endpointing and keyterms once it is up", async () => {
    const { session, sockets } = await open();
    session.updateEndpointing?.(1200);
    session.updateKeyterms?.(["Lucas", "Santos"]);
    speakUnheard(session, STT_DEAF_VOICED_MS);
    await tick();
    expect(sockets[1]?.updateConfiguration).toHaveBeenCalledWith({ min_turn_silence: 1200 });
    expect(sockets[1]?.updateConfiguration).toHaveBeenCalledWith({
      keyterms_prompt: ["Lucas", "Santos"],
    });
    await session.close();
  });
});
