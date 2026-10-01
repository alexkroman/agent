// Copyright 2026 the AAI authors. MIT license.
// The two seams between one turn and a tool's own speech: where a tool message
// goes OUT, and what a verbatim completion contributes on the way back.
//
// `../tool-messages.test.ts` drives both through a real turn. These are
// the module's own claims — the ones that have no turn to observe them,
// starting with the one that cost a spec a wrong observation point: the
// handler is read LIVE.

import { describe, expect, test } from "vitest";
import { silentLogger } from "../../../_test-utils.ts";
import { createToolSpeechController } from "../../../tools/index.ts";
import { createTtsTextCoalescer } from "../output/index.ts";
import { createStreamPartHandler, type StreamPartHandler } from "../reply/index.ts";
import { bindToolSpeech, stepMessages } from "./tool-speech.ts";
import type { StepResult } from "./types.ts";

function controller() {
  return createToolSpeechController({ log: silentLogger, sid: "s", random: () => 0 });
}

/** A real stream-part handler over a real coalescer, as one turn builds it. */
function turnHandler(spoken: string[], deltas: string[] = []): StreamPartHandler {
  const tts = createTtsTextCoalescer((t) => spoken.push(t));
  return createStreamPartHandler({
    onDelta: (d) => deltas.push(d),
    sendTtsText: tts.send,
    onTtsBoundary: tts.boundary,
    onToolCall: () => undefined,
    // Not a filler spec, and nothing disposes these handlers: 0 keeps the
    // construction-time cover window from outliving the test.
    deadAirCoverMs: 0,
    emitError: () => undefined,
    log: silentLogger,
    sid: "s",
  });
}

describe("bindToolSpeech", () => {
  test("routes a tool's line through the CURRENT handler, not the one it was bound with", async () => {
    // The load-bearing claim. A poisoned-adoption restart REPLACES the
    // handler and its coalescer, so a captured one would send the restarted
    // turn's tool lines into a batch belonging to the run that was abandoned.
    const first: string[] = [];
    const second: string[] = [];
    let live = turnHandler(first);
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, { handler: () => live, callerSpeaking: undefined });
    await toolSpeech.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined)?.start();
    live = turnHandler(second);
    await toolSpeech.begin({ start: [{ content: "Two secs." }] }, "b", {}, undefined)?.start();
    expect(first).toEqual(["One sec."]);
    expect(second).toEqual(["Two secs."]);
  });

  test("a verbatim completion reaches the transcript, and filler never does", async () => {
    const deltas: string[] = [];
    const spoken: string[] = [];
    const handler = turnHandler(spoken, deltas);
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, { handler: () => handler, callerSpeaking: undefined });
    const call = toolSpeech.begin(
      { start: [{ content: "One sec." }], complete: [{ content: "All done." }] },
      "a",
      {},
      undefined,
    );
    await call?.start();
    call?.settled("{}");
    expect(spoken).toEqual(["One sec.", " All done."]);
    // Only the answer is the turn's transcript. The hold line is heard and not
    // recorded, which is the whole barge-in guarantee.
    expect(deltas).toEqual(["All done."]);
  });

  test("a tool's line is SEPARATED from the model's words around it", async () => {
    // The drifted bug `speakInReply` fixed: only the dead-air cover went
    // through the handler's segment separator, so a tool line sent straight
    // to the coalescer fused onto the sentence before it ("check.One sec.") —
    // in the caption, and for a verbatim completion in the recorded text.
    const deltas: string[] = [];
    const spoken: string[] = [];
    const handler = turnHandler(spoken, deltas);
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, { handler: () => handler, callerSpeaking: undefined });
    handler.handle({ type: "text-delta", text: "Let me check." });
    const call = toolSpeech.begin(
      { start: [{ content: "One sec." }], complete: [{ content: "It ships Tuesday." }] },
      "a",
      {},
      undefined,
    );
    await call?.start();
    call?.settled("{}");
    expect(spoken.join("")).toBe("Let me check. One sec. It ships Tuesday.");
    expect(deltas.join("")).toBe("Let me check. It ships Tuesday.");
  });

  test("the unbind thunk stops further lines", async () => {
    const spoken: string[] = [];
    const handler = turnHandler(spoken);
    const toolSpeech = controller();
    const unbind = bindToolSpeech(toolSpeech, {
      handler: () => handler,
      callerSpeaking: undefined,
    });
    unbind();
    await toolSpeech.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined)?.start();
    expect(spoken).toEqual([]);
  });

  test("with no controller it answers a no-op THUNK, never undefined", () => {
    // `consumeLlmStream` calls it unconditionally in its `finally`: that
    // function is at its cognitive-complexity ceiling and an optional chain
    // costs a point.
    const unbind = bindToolSpeech(undefined, {
      handler: () => undefined,
      callerSpeaking: undefined,
    });
    expect(typeof unbind).toBe("function");
    expect(unbind()).toBeUndefined();
  });

  test("`callerSpeaking` is honoured, and absent means never", async () => {
    const spoken: string[] = [];
    const handler = turnHandler(spoken);
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, { handler: () => handler, callerSpeaking: () => true });
    await toolSpeech.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined)?.start();
    expect(spoken).toEqual([]);
  });
});

describe("stepMessages", () => {
  const step = (content: string): StepResult => ({
    response: { messages: [{ role: "assistant", content }] },
  });

  test("is every step's messages when no verbatim completion was spoken", () => {
    expect(stepMessages([step("a"), step("b")], controller())).toEqual([
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  test("appends the sentence no step produced, LAST", () => {
    const toolSpeech = controller();
    toolSpeech.bind({
      speak: () => undefined,
      callerSpeaking: () => false,
      awaitSpoken: () => Promise.resolve(),
    });
    toolSpeech
      .begin({ complete: [{ role: "assistant", content: "Shipped Tuesday." }] }, "a", {}, undefined)
      ?.settled("{}");
    // After the step that produced the tool result, which is where the caller
    // heard it — and present at all only because the model was never asked.
    expect(stepMessages([step("a")], toolSpeech)).toEqual([
      { role: "assistant", content: "a" },
      { role: "assistant", content: "Shipped Tuesday." },
    ]);
  });

  test("with no controller at all it is the steps unchanged", () => {
    expect(stepMessages([step("a")], undefined)).toEqual([{ role: "assistant", content: "a" }]);
  });
});
