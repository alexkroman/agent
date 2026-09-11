// Copyright 2026 the AAI authors. MIT license.
// The two seams between one turn and a tool's own speech: where a tool message
// goes OUT, and what a verbatim completion contributes on the way back.
//
// `pipeline-tool-messages.test.ts` drives both through a real turn. These are
// the module's own claims — the ones that have no turn to observe them,
// starting with the one that cost a spec a wrong observation point: the
// coalescer is read LIVE.

import { describe, expect, test } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { createToolSpeechController } from "../tool-messages-runner.ts";
import { bindToolSpeech, stepMessages } from "./pipeline-llm-tool-speech.ts";
import type { StepResult } from "./pipeline-llm-types.ts";
import { createTtsTextCoalescer, type TtsTextCoalescer } from "./pipeline-stream.ts";

function controller() {
  return createToolSpeechController({ log: silentLogger, sid: "s", random: () => 0 });
}

describe("bindToolSpeech", () => {
  test("routes a tool's line through the CURRENT coalescer, not the one it was bound with", async () => {
    // The load-bearing claim. A poisoned-adoption restart REPLACES the
    // coalescer, so a captured one would send the restarted turn's tool lines
    // into a batch belonging to the run that was abandoned.
    const first: string[] = [];
    const second: string[] = [];
    let live: TtsTextCoalescer = createTtsTextCoalescer((t) => first.push(t));
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, {
      coalescer: () => live,
      onDelta: () => undefined,
      callerSpeaking: undefined,
    });
    await toolSpeech.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined)?.start();
    live = createTtsTextCoalescer((t) => second.push(t));
    await toolSpeech.begin({ start: [{ content: "Two secs." }] }, "b", {}, undefined)?.start();
    expect(first).toEqual(["One sec."]);
    expect(second).toEqual(["Two secs."]);
  });

  test("a verbatim completion reaches `onDelta`, and filler never does", async () => {
    const deltas: string[] = [];
    const spoken: string[] = [];
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, {
      coalescer: () => createTtsTextCoalescer((t) => spoken.push(t)),
      onDelta: (delta) => deltas.push(delta),
      callerSpeaking: undefined,
    });
    const call = toolSpeech.begin(
      { start: [{ content: "One sec." }], complete: [{ content: "All done." }] },
      "a",
      {},
      undefined,
    );
    await call?.start();
    call?.settled("{}");
    expect(spoken).toEqual(["One sec.", "All done."]);
    // Only the answer is the turn's transcript. The hold line is heard and not
    // recorded, which is the whole barge-in guarantee.
    expect(deltas).toEqual(["All done."]);
  });

  test("the unbind thunk stops further lines", async () => {
    const spoken: string[] = [];
    const toolSpeech = controller();
    const unbind = bindToolSpeech(toolSpeech, {
      coalescer: () => createTtsTextCoalescer((t) => spoken.push(t)),
      onDelta: () => undefined,
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
      coalescer: () => createTtsTextCoalescer(() => undefined),
      onDelta: () => undefined,
      callerSpeaking: undefined,
    });
    expect(typeof unbind).toBe("function");
    expect(unbind()).toBeUndefined();
  });

  test("`callerSpeaking` is honoured, and absent means never", async () => {
    const spoken: string[] = [];
    const toolSpeech = controller();
    bindToolSpeech(toolSpeech, {
      coalescer: () => createTtsTextCoalescer((t) => spoken.push(t)),
      onDelta: () => undefined,
      callerSpeaking: () => true,
    });
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
      send: () => undefined,
      boundary: () => undefined,
      record: () => undefined,
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
