// Copyright 2026 the AAI authors. MIT license.
/**
 * Where the AssemblyAI streaming TTS adapter CUTS a reply, driven through the
 * adapter rather than through `splitSegment` directly — the rule is only worth
 * anything as the `Generate`+`Flush` pairs it actually produces.
 *
 * Split out of `assemblyai.test.ts` when that file passed the 700-line test
 * cap, along the same seam the source takes: `assemblyai-segment.ts` owns this
 * one measured rule, and its module doc carries every measurement these tests
 * assert the consequences of.
 */

import { DEAD_AIR_OPENING_PHRASE } from "@alexkroman1/aai/host-internal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { FakeWebSocket, pcmBase64 } from "./_fake-ws-test-utils.ts";

// Async factory importing an import-free module: the adapter's own "ws"
// import must not be reachable from the factory (it would re-enter the mock).
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./_fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("AssemblyAI TTS segment flushing", () => {
  // The service synthesizes NOTHING until it receives a Flush: measured
  // against production, a turn's Generate frames produce zero audio and the
  // first Audio frame lands ~33ms after Flush. The pipeline only flushes at
  // the end-of-turn drain (flushTtsAndWait, once per reply — after every LLM
  // step AND every tool call), so without a segment flush time-to-first-audio
  // is the whole turn. Cartesia has no equivalent: `continue: true` starts
  // synthesis on arrival.
  test("flushes at a sentence boundary so synthesis starts mid-stream", async () => {
    const { session, ws } = await openSession();
    session.sendText("Sure, I can help with that. ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "Sure, I can help with that. " },
      { type: "Flush" },
    ]);
  });

  test("does not flush mid-sentence text", async () => {
    const { session, ws } = await openSession();
    session.sendText("Sure, I can help ");
    expect(ws._frames()).toEqual([]);
  });

  test("does not flush a single-token fragment", async () => {
    // "Dr. " is an abbreviation, not a sentence end. Flushing it makes a
    // word-sized utterance: measured 25% longer total audio for the same
    // text, because each flushed segment gets its own prosody and padding.
    const { session, ws } = await openSession();
    session.sendText("Dr. ");
    expect(ws._frames()).toEqual([]);
  });

  test.each([
    ["a straight double quote", 'She said "we are done." ', 'She said "we are done." '],
    ["a curly double quote", "She said “we are done.” ", "She said “we are done.” "],
    ["a curly single quote", "He said ‘we are done.’ ", "He said ‘we are done.’ "],
  ] as const)("a sentence closed by %s is a segment boundary", async (_label, text, expected) => {
    // The curly forms are what an LLM emits by DEFAULT, so a straight-only
    // closer class made this the common case rather than the edge one: the
    // sentence end was invisible, the cut fell to the character budget in
    // the middle of the NEXT sentence, and the model was handed a fragment
    // with no cadence to aim for. Measured against the sandbox host, that
    // cost 3x the run-to-run duration spread (18% vs 6%) at identical
    // time-to-first-audio — see the module doc in assemblyai-segment.ts.
    const { session, ws } = await openSession();
    session.sendText(text);
    expect(ws._frames()).toEqual([{ type: "Generate", text: expected }, { type: "Flush" }]);
  });

  test("an apostrophe inside a word is still not a sentence end", async () => {
    // `’` earns its place in the closer class only AFTER terminal
    // punctuation, so its far commoner role as an apostrophe is untouched.
    const { session, ws } = await openSession();
    session.sendText("It isn’t your sister’s voice ");
    expect(ws._frames()).toEqual([]);
  });

  test("a decimal point is not a sentence end", async () => {
    const { session, ws } = await openSession();
    session.sendText("The total is 3.5 million ");
    expect(ws._frames()).toEqual([]);
  });

  test("keeps an abbreviation with the sentence that follows it", async () => {
    const { session, ws } = await openSession();
    session.sendText("Dr. ");
    session.sendText("Smith is here. ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "Dr. Smith is here. " },
      { type: "Flush" },
    ]);
  });

  test("splits a sentence end buried mid-delta rather than missing it", async () => {
    // The pipeline coalescer's 32-char cap can put a sentence end in the
    // middle of a chunk. Matching only the chunk's tail would miss it and
    // silently restore the whole-turn lag, so the split happens here.
    const { session, ws } = await openSession();
    session.sendText("All done. And now the next ");
    expect(ws._frames()).toEqual([{ type: "Generate", text: "All done. " }, { type: "Flush" }]);

    session.flush();
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "All done. " },
      { type: "Flush" },
      { type: "Generate", text: "And now the next " },
      { type: "Flush" },
    ]);
  });

  test("flushes through the last complete sentence when several arrive at once", async () => {
    // One larger segment sounds better than several small ones.
    const { session, ws } = await openSession();
    session.sendText("One thing. Two things. Still going ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "One thing. Two things. " },
      { type: "Flush" },
    ]);
  });

  test("flushes at the character budget when no sentence end arrives", async () => {
    // Sentence-only segmentation makes time-to-first-audio the length of the
    // reply's FIRST SENTENCE, and a long opening clause is most of a second of
    // silence on its own. Measured against production: 538ms to first audio
    // sentence-only vs 286ms with the budget. See the module doc.
    const { session, ws } = await openSession();
    session.sendText("Let me pull up the details on that order for you ");
    expect(ws._frames()).toEqual([
      // Cut after the last WHOLE word inside the budget — never mid-token.
      { type: "Generate", text: "Let me pull up the details on that " },
      { type: "Flush" },
    ]);
  });

  test("holds text that has not reached the budget or a sentence end", async () => {
    const { session, ws } = await openSession();
    session.sendText("Let me pull up the ");
    expect(ws._frames()).toEqual([]);
  });

  test("a sentence boundary wins over the budget even when far past it", async () => {
    // The budget only bounds the WAIT for a sentence end; it is not a cap. A
    // buffer holding complete sentences still flushes as one large segment,
    // which is both better prosody and fewer round trips.
    const { session, ws } = await openSession();
    session.sendText("One thing happened. Two things happened. Still going ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "One thing happened. Two things happened. " },
      { type: "Flush" },
    ]);
  });

  test("flushes a single token that overruns the budget rather than holding it", async () => {
    // Once one token is longer than the budget, "wait for a word that fits"
    // can never become true again — every later delta only lengthens the
    // buffer — so holding would strand the text until end of turn.
    const { session, ws } = await openSession();
    session.sendText("https://example.com/orders/1234567890/tracking next ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "https://example.com/orders/1234567890/tracking " },
      { type: "Flush" },
    ]);
  });

  test("emits every whole segment a single delta carries", async () => {
    // A budget split consumes only its own segment, so without looping a burst
    // would dribble out one segment per LATER delta — and stall completely if
    // none followed, restoring the whole-turn lag this adapter exists to avoid.
    const { session, ws } = await openSession();
    session.sendText(
      "Let me pull up the details on that order for you and check the warehouse status now ",
    );
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "Let me pull up the details on that " },
      { type: "Flush" },
      { type: "Generate", text: "order for you and check the warehouse " },
      { type: "Flush" },
    ]);
  });

  test("budget segments each hold the turn open until the end-of-turn flush", async () => {
    // Every segment earns its own FlushDone, but `done` may only fire for the
    // last: flushTtsAndWait resolves on it, so a premature one advances the
    // orchestrator while later segments are still synthesizing.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText(
      "Let me pull up the details on that order for you and check the warehouse status now ",
    );
    ws._msg({ type: "FlushDone" }); // first budget segment
    ws._msg({ type: "FlushDone" }); // second budget segment
    expect(onDone).not.toHaveBeenCalled();

    session.flush(); // end of turn — "status now " is still buffered
    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("flushes a short cover phrase, which must be audible during tool execution", async () => {
    // DEAD_AIR_OPENING_PHRASE is "I'm checking on this." — four words. Its
    // entire purpose is to break silence while a tool runs, so it cannot wait
    // for the turn's end-of-turn flush.
    const { session, ws } = await openSession();
    session.sendText(DEAD_AIR_OPENING_PHRASE);
    expect(ws._frames()).toContainEqual({ type: "Flush" });
  });

  test("a segment flush does not end the turn", async () => {
    // The turn ends on the end-of-turn flush's FlushDone, not a segment's:
    // flushTtsAndWait resolves on `done`, so a premature one advances the
    // orchestrator while audio is still streaming.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("First sentence here. ");
    ws._msg({ type: "FlushDone" }); // the segment's
    expect(onDone).not.toHaveBeenCalled();

    session.sendText("And the rest ");
    session.flush(); // end of turn
    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("accumulates across deltas and flushes once the sentence completes", async () => {
    const { session, ws } = await openSession();
    session.sendText("Sure, ");
    session.sendText("I can help ");
    session.sendText("with that. ");
    expect(ws._frames()).toEqual([
      { type: "Generate", text: "Sure, I can help with that. " },
      { type: "Flush" },
    ]);
  });

  test("never sends an empty Flush at end of turn", async () => {
    // Observed against production: an empty Flush can go unacknowledged, and
    // `done` then never fires — flushTtsAndWait would burn its full timeout on
    // every turn, which is worse than the lag this flushing fixes.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("The whole reply fits in one sentence. ");
    ws._msg({ type: "FlushDone" });
    const before = ws._frames().length;

    session.flush(); // nothing buffered
    expect(ws._frames()).toHaveLength(before);
    // All synthesis was already acknowledged, so the turn ends here.
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("an end-of-turn flush with nothing buffered waits for outstanding audio", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("One sentence. ");
    session.flush(); // nothing buffered, but the segment is unacknowledged
    expect(onDone).not.toHaveBeenCalled();

    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("a segment's is_final does not end the turn either", async () => {
    // Older servers flag the last Audio frame instead of sending FlushDone;
    // per segment that signal means the same thing and must be gated the same.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);
    session.sendText("First sentence here. ");
    ws._msg({ type: "Audio", audio: pcmBase64([1]), is_final: true });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("an is_final AND its FlushDone count as one acknowledgement", async () => {
    // A server may signal a synthesis's completion both ways. Counting the
    // pair twice reads the surplus FlushDone as unsolicited and ends the
    // turn mid-reply — done fires while later sentences are still
    // synthesizing, audio_done overtakes their audio, and the buffered text
    // below ("And the rest") is dropped: the voice cuts off before the
    // reply finishes. Exhaustive ack-pairing cases: assemblyai-turn.test.ts.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("First sentence here. ");
    session.sendText("And the rest");
    ws._msg({ type: "Audio", audio: pcmBase64([1]), is_final: true }); // segment's final frame
    ws._msg({ type: "FlushDone" }); // same flush, acked again
    expect(onDone).not.toHaveBeenCalled();

    session.sendText(" of the reply. ");
    session.flush(); // end of turn — "And the rest of the reply. " must go out
    expect(ws._frames()).toContainEqual({
      type: "Generate",
      text: "And the rest of the reply. ",
    });
    expect(onDone).not.toHaveBeenCalled();

    ws._msg({ type: "Audio", audio: pcmBase64([2]), is_final: true });
    expect(onDone).toHaveBeenCalledTimes(1); // exactly once, on the LAST flush's acknowledgement
    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("cancel clears pending segment state so the next turn ends normally", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("Interrupted sentence. ");
    session.cancel(); // emits done for the cancelled turn; the socket survives
    expect(onDone).toHaveBeenCalledTimes(1);

    ws._msg({ type: "Cancelled" }); // boundary — the next turn's frames count
    session.sendText("New turn ");
    session.flush();
    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});
