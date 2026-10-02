// Copyright 2026 the AAI authors. MIT license.
// `startSpeculativeStream`: the tape a speculation drains into, its poison
// rule, and the usage it holds back until a turn adopts it.

import { describe, expect, test, vi } from "vitest";
import type { ScriptedPart } from "../../../_fake-llm.ts";
import { silentLogger } from "../../../_logger-test-utils.ts";
import { createFakeLanguageModel } from "../../../_pipeline-test-fakes.ts";
import { useVirtualTime } from "../../_pipeline-transport-harness.ts";
import { type SpeculativeRequest, startSpeculativeStream } from "./speculative-stream.ts";
import type { TapeEntry } from "./types.ts";

useVirtualTime();

function request(script: ScriptedPart[], overrides: Partial<SpeculativeRequest> = {}) {
  return {
    llm: createFakeLanguageModel({ script, delayMs: 10 }),
    systemPrompt: "s",
    messages: [{ role: "user" as const, content: "where is my order" }],
    tools: {},
    toolChoice: "auto" as const,
    temperature: undefined,
    repairToolCall: async () => null,
    maxSteps: 1,
    log: silentLogger,
    sid: "sid-spec",
    ...overrides,
  } satisfies SpeculativeRequest;
}

async function collect(entries: AsyncIterable<TapeEntry>): Promise<TapeEntry[]> {
  const out: TapeEntry[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}

function spokenText(entries: readonly TapeEntry[]): string {
  return entries
    .map((entry) =>
      entry.kind === "part" && entry.part.type === "text-delta" ? entry.part.text : "",
    )
    .join("");
}

describe("startSpeculativeStream", () => {
  test("an adopter replays the whole tape, step marker included", async () => {
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "It ships Tuesday." }]),
      "where is my order",
      silentLogger,
      new AbortController().signal,
    );
    expect(spec.prompt).toBe("where is my order");
    await vi.advanceTimersByTimeAsync(1000);
    const adopted = spec.adopt(new AbortController().signal);
    const entries = await collect(adopted.entries());
    expect(spokenText(entries)).toBe("It ships Tuesday.");
    expect(entries.some((entry) => entry.kind === "step")).toBe(true);
    expect(spec.poisoned()).toBe(false);
  });

  test("an adopter that arrives mid-stream FOLLOWS the run to its end", async () => {
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "one two three four" }]),
      "q",
      silentLogger,
      new AbortController().signal,
    );
    const adopted = spec.adopt(new AbortController().signal);
    const done = collect(adopted.entries());
    await vi.advanceTimersByTimeAsync(1000);
    expect(spokenText(await done)).toBe("one two three four");
  });

  test.each<[string, ScriptedPart]>([
    ["a tool call", { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
    ["an error", { type: "error", error: new Error("boom") }],
  ])("%s poisons the speculation", async (_label, part) => {
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "Let me check." }, part]),
      "q",
      silentLogger,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(spec.poisoned()).toBe(true);
  });

  test("usage is held back until adoption, then reported to the session", async () => {
    const onUsage = vi.fn();
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "hi" }], { onUsage }),
      "q",
      silentLogger,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUsage).not.toHaveBeenCalled();
    spec.adopt(new AbortController().signal);
    expect(onUsage).toHaveBeenCalled();
  });

  test("abort is local, and the session signal aborts it too", () => {
    const session = new AbortController();
    const a = startSpeculativeStream(request([]), "q", silentLogger, session.signal);
    const b = startSpeculativeStream(request([]), "q", silentLogger, session.signal);
    a.abort();
    expect([a.aborted(), b.aborted()]).toEqual([true, false]);
    session.abort();
    expect(b.aborted()).toBe(true);
  });

  test("adoption re-parents the request onto the turn's signal", () => {
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "hi" }]),
      "q",
      silentLogger,
      new AbortController().signal,
    );
    const turn = new AbortController();
    spec.adopt(turn.signal);
    expect(spec.aborted()).toBe(false);
    turn.abort();
    expect(spec.aborted()).toBe(true);
  });

  test("adopting onto an already-aborted turn aborts at once", () => {
    const spec = startSpeculativeStream(
      request([{ type: "text", text: "hi" }]),
      "q",
      silentLogger,
      new AbortController().signal,
    );
    spec.adopt(AbortSignal.abort());
    expect(spec.aborted()).toBe(true);
  });
});
