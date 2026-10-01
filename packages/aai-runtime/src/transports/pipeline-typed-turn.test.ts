// Copyright 2026 the AAI authors. MIT license.
// A TYPED turn — the client's `user_text`, reaching the pipeline transport as
// `sendUserText`. The claim is "answered exactly as if the transcriber had
// committed it", so every case is asserted on what was REPORTED (and in what
// order), what the model was ASKED and what the caller HEARD — the same three
// things a spoken turn is graded on — never on an internal flag.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import {
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  spoken,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import type { Transport } from "./types.ts";

useVirtualTime();

/** Narrowed once: `sendUserText` is optional on `Transport` (S2S omits it). */
function typer(t: Transport): (text: string) => void {
  const send = t.sendUserText;
  if (!send) throw new Error("the pipeline transport must define sendUserText");
  return send;
}

describe("a typed turn through the pipeline transport", () => {
  test("is reported, asked and spoken like a committed transcript", async () => {
    const { opts, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "It is sunny." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    typer(t)("what's the weather");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    expect(callbacks.reported("userTranscript.committed")).toHaveBeenCalledExactlyOnceWith({
      type: "userTranscript.committed",
      text: "what's the weather",
    });
    // The model was asked the typed words as the caller's turn...
    expect(JSON.stringify(llmCalls(opts).calls[0]?.prompt)).toContain("what's the weather");
    // ...and the answer went to the speaker, not only to the transcript.
    expect(spoken(tts)).toBe("It is sunny.");
    // Into silence there was nothing to interrupt, and nothing says there was.
    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
    await t.stop();
  });

  test("cuts a reply in flight, and reports the cut BEFORE the new turn", async () => {
    // The order is the stream's: a reader of the retained log must see the old
    // reply end before the turn that replaced it began.
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [inFlightReplyScript(), [{ type: "text", text: "sure" }]],
        delayMs: 20,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("tell me a long story");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length ?? 0).toBeGreaterThan(0);
    });

    typer(t)("actually, stop — what time is it");
    const order = callbacks.events
      .map((e) => e.type)
      .filter((type) => type === "reply.cancelled" || type === "userTranscript.committed");
    expect(order).toEqual([
      "userTranscript.committed",
      "reply.cancelled",
      "userTranscript.committed",
    ]);
    expect(callbacks.reported("userTranscript.committed")).toHaveBeenLastCalledWith({
      type: "userTranscript.committed",
      text: "actually, stop — what time is it",
    });
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(2);
    });
    await t.stop();
  });

  test("interrupts even a reply the barge-in thresholds would have let finish", async () => {
    // A spoken "ok" over the agent is below `minBargeInWords` and deferred; a
    // typed message is deliberate by construction, so no word count applies.
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      minBargeInWords: 5,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("go on");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length ?? 0).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(2400));

    typer(t)("ok");
    expect(callbacks.reported("reply.cancelled")).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("is answered under push-to-talk without the button", async () => {
    // `turnDetection: "manual"` is about who ends a SPOKEN turn; a typed one is
    // complete when it arrives, so no user_turn_* edge is owed around it.
    const { opts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      turnDetection: "manual",
    });
    const t = createPipelineTransport(opts);
    await t.start();

    typer(t)("book it");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    expect(callbacks.reported("userTranscript.committed")).toHaveBeenCalledWith({
      type: "userTranscript.committed",
      text: "book it",
    });
    await t.stop();
  });

  test("answers nothing once the transport has stopped", async () => {
    const { opts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await t.stop();

    typer(t)("hello?");
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.reported("userTranscript.committed")).not.toHaveBeenCalled();
    expect(llmCalls(opts).calls).toHaveLength(0);
  });
});
