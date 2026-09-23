// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixed lines — the caption rule every one of them shares, and the history rule
 * a line spoken as a reply of its own owes.
 *
 * The history half is the behaviour the greeting did NOT have before it went
 * through `createLineReply`: it pushed the whole line up front, so a caller who
 * cut it off after two words left a record saying all of it was delivered. The
 * cases below cut it at each point that matters — before anything was audible,
 * part-way through, and after a reset moved the conversation on.
 */

import type { SessionEventBody } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { createHeardTracker } from "./pipeline-heard.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createLineReply, speakFixedLine } from "./pipeline-lines.ts";
import { createTurnGate } from "./pipeline-turn-gate.ts";
import { createTurnMachine } from "./pipeline-turn-state.ts";
import type { SendTtsOptions } from "./types.ts";

const SAMPLE_RATE = 16_000;
const LINE = "Hello there, thanks for calling Acme support today.";

/** `ms` of silent PCM16 at {@link SAMPLE_RATE}. */
function pcm(ms: number): Int16Array {
  return new Int16Array((SAMPLE_RATE * ms) / 1000);
}

/**
 * A line reply over the REAL heard cursor, history and gate, with the reply
 * scaffold and the TTS drain scripted — `drain` decides what happens while the
 * line is "playing", and gets the lever to cut it.
 */
function harness(
  drain: (h: { cut: () => void; advance: (ms: number) => void }) => void,
  clock?: () => number,
) {
  let now = 0;
  const heard = createHeardTracker({ sampleRate: SAMPLE_RATE, now: clock ?? (() => now) });
  const history = createPipelineHistory();
  const gate = createTurnGate();
  const reported: SessionEventBody[] = [];
  const sends: { text: string; opts: SendTtsOptions | undefined }[] = [];
  const ctl = new AbortController();
  // What a barge-in does to the reply: latch the heard position, then abort.
  const cut = (): void => {
    heard.cut();
    ctl.abort();
  };
  const reply = createLineReply({
    sendTtsText: (text, opts) => {
      sends.push({ text, opts });
      heard.onText(text, opts?.record !== false);
    },
    callbacks: { report: (event) => reported.push(event) },
    history,
    heard,
    gate,
    turns: createTurnMachine(),
    drainTts: () => {
      drain({
        cut,
        advance: (ms) => {
          now += ms;
        },
      });
      return Promise.resolve();
    },
    runReply: async (_prefix, body) => {
      heard.startReply();
      await body(ctl.signal);
    },
  });
  return { reply, heard, history, gate, reported, sends, cut };
}

describe("speakFixedLine", () => {
  test("captions a FINAL before the text reaches TTS, with the interim suppressed", () => {
    const order: string[] = [];
    speakFixedLine(
      {
        sendTtsText: (_text, opts) => order.push(`tts publish=${String(opts?.publishTranscript)}`),
        callbacks: { report: (event) => order.push(event.type) },
      },
      { text: "Sorry, I had a problem." },
    );
    expect(order).toEqual(["agent-transcript.committed", "tts publish=false"]);
  });

  test("a recovery phrase carries its tag; a recorded line carries none", () => {
    const reported: SessionEventBody[] = [];
    const deps = {
      sendTtsText: () => undefined,
      callbacks: { report: (e: SessionEventBody) => reported.push(e) },
    };
    speakFixedLine(deps, { text: "Sorry.", recovery: "turn-failed" });
    speakFixedLine(deps, { text: "Hi!" });
    expect(reported).toEqual([
      { type: "agent-transcript.committed", text: "Sorry.", recovery: "turn-failed" },
      { type: "agent-transcript.committed", text: "Hi!" },
    ]);
  });
});

describe("createLineReply", () => {
  test("a line that PLAYED is recorded whole, in both views", async () => {
    const { reply, history } = harness(() => undefined);
    await reply("pipeline-greeting", LINE);
    expect(history.conversation).toEqual([{ role: "assistant", content: LINE }]);
    expect(history.llm).toEqual([{ role: "assistant", content: LINE }]);
  });

  test("a line cut part-way is recorded as the heard PREFIX, marked [interrupted]", async () => {
    const { reply, heard, history } = harness(({ advance, cut }) => {
      // Two seconds of the line's audio forwarded, then a barge-in 1.5s in.
      heard.onAudio(pcm(2000));
      advance(1500);
      cut();
    });
    await reply("pipeline-greeting", LINE);

    const [entry] = history.conversation;
    expect(history.conversation).toHaveLength(1);
    const content = String(entry?.content);
    expect(content.endsWith(" [interrupted]")).toBe(true);
    const spoken = content.slice(0, -" [interrupted]".length);
    // A real, strict prefix: some of the line was heard, and not all of it.
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.length).toBeLessThan(LINE.length);
    expect(LINE.startsWith(spoken)).toBe(true);
  });

  test("a line cut during PLAYBACK — after synthesis finished — is still the heard prefix", async () => {
    // The usual case, and the one recording at the drain got wrong: synthesis
    // outruns real time, so the drain resolves with most of the line still in
    // the client's buffer, and a caller cutting in there was recorded as having
    // heard all of it. The reply now stays in flight until playback is over.
    vi.useFakeTimers();
    try {
      const h = harness(() => undefined, Date.now);
      const done = h.reply("pipeline-greeting", LINE);
      // Four seconds of audio forwarded, and synthesis already finished.
      h.heard.onAudio(pcm(4000));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.history.conversation).toEqual([]);
      h.cut();
      await vi.advanceTimersByTimeAsync(0);
      await done;

      const content = String(h.history.conversation[0]?.content);
      expect(h.history.conversation).toHaveLength(1);
      expect(content.endsWith(" [interrupted]")).toBe(true);
      expect(content.length - " [interrupted]".length).toBeLessThan(LINE.length);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a line that plays OUT is recorded only once playback is over", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => undefined, Date.now);
      const done = h.reply("pipeline-greeting", LINE);
      h.heard.onAudio(pcm(4000));
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.history.conversation).toEqual([]);
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(h.history.conversation).toEqual([{ role: "assistant", content: LINE }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a line cut before anything was audible records NOTHING", async () => {
    const { reply, history } = harness(({ cut }) => cut());
    await reply("pipeline-greeting", LINE);
    expect(history.conversation).toEqual([]);
    expect(history.llm).toEqual([]);
  });

  test("a reset while the line plays keeps it out of the NEW conversation", async () => {
    const box: { gate?: ReturnType<typeof createTurnGate> } = {};
    const h = harness(() => box.gate?.invalidateAll());
    box.gate = h.gate;
    await h.reply("pipeline-greeting", LINE);
    expect(h.history.conversation).toEqual([]);
  });

  test("the caption is still committed up front, whatever the outcome", async () => {
    const { reply, reported, sends } = harness(({ cut }) => cut());
    await reply("pipeline-greeting", LINE);
    expect(reported).toEqual([{ type: "agent-transcript.committed", text: LINE }]);
    expect(sends).toEqual([{ text: LINE, opts: { publishTranscript: false } }]);
  });
});
