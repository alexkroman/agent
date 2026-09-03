// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { stubGenerate } from "./testing-generate.ts";

const GRADER = "You grade documents.";
const ANSWERER = "You answer questions.";

describe("stubGenerate", () => {
  test("routes by system prompt, so a multi-call tool can be driven down one path", async () => {
    const model = stubGenerate({
      [GRADER]: { object: { score: "yes" } },
      [ANSWERER]: "The documented answer.",
    });

    expect(await model.generate({ system: GRADER, prompt: "doc" })).toEqual({
      text: '{"score":"yes"}',
      object: { score: "yes" },
    });
    expect(await model.generate({ system: ANSWERER, prompt: "q" })).toEqual({
      text: "The documented answer.",
      object: null,
    });
  });

  test("a schema call's text is the stringified object, as the host returns it", async () => {
    const model = stubGenerate({ object: { steps: ["one"] } });
    const { text, object } = await model.generate({ prompt: "plan" });
    expect(object).toEqual({ steps: ["one"] });
    expect(JSON.parse(text)).toEqual({ steps: ["one"] });
  });

  test("an explicit text wins over the derived one", async () => {
    const model = stubGenerate({ text: "spoken form", object: { score: "no" } });
    expect((await model.generate({ prompt: "x" })).text).toBe("spoken form");
  });

  test("a function route sees the call, which is what a queue needs", async () => {
    const verdicts = ["yes", "no"];
    const model = stubGenerate({
      [GRADER]: (call) => ({ object: { score: verdicts.shift(), of: call.prompt } }),
    });

    expect((await model.generate({ system: GRADER, prompt: "D1" })).object).toEqual({
      score: "yes",
      of: "D1",
    });
    expect((await model.generate({ system: GRADER, prompt: "D2" })).object).toEqual({
      score: "no",
      of: "D2",
    });
  });

  test("records every call in order, with the whole options object", async () => {
    const model = stubGenerate("ok");
    await model.generate({ prompt: "first", temperature: 0.2 });
    await model.generate({ system: "S", prompt: "second" });

    expect(model.calls.map((call) => [call.system, call.prompt])).toEqual([
      [undefined, "first"],
      ["S", "second"],
    ]);
    expect(model.calls[0]?.options.temperature).toBe(0.2);
  });

  test("a single route answers every call, whatever its system prompt", async () => {
    const model = stubGenerate("always");
    expect((await model.generate({ system: "anything", prompt: "a" })).text).toBe("always");
    expect((await model.generate({ prompt: "b" })).text).toBe("always");
  });

  test("an unrouted call throws naming the system it carried and the ones routed", async () => {
    const model = stubGenerate({ [GRADER]: "graded" });
    await expect(model.generate({ system: "You do something else.", prompt: "x" })).rejects.toThrow(
      /no route for this call's system prompt.*You do something else.*You grade documents/s,
    );
  });

  test("an unrouted call with NO system prompt says that, rather than printing undefined", async () => {
    const model = stubGenerate({ [GRADER]: "graded" });
    await expect(model.generate({ prompt: "x" })).rejects.toThrow("It carried: (none).");
  });

  test("a long system prompt is shortened to its first line in the error", async () => {
    const long = `${"A".repeat(200)}\nsecond line`;
    const model = stubGenerate({ [long]: "ok" });
    await expect(model.generate({ system: "other", prompt: "x" })).rejects.toThrow(/…/);
  });
});
