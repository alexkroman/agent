// Copyright 2026 the AAI authors. MIT license.
// `drainEntries`: what reaches the part handler, and where an adopted run stops.

import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { StreamPart, StreamPartHandler } from "../reply/index.ts";
import { drainEntries, partsAsEntries } from "./drain.ts";
import type { TapeEntry } from "./types.ts";

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function recordingHandler(): StreamPartHandler & { parts: StreamPart[] } {
  const parts: StreamPart[] = [];
  return {
    parts,
    handle: (part) => parts.push(part),
    dispose: () => undefined,
    errored: () => false,
    speak: () => undefined,
  };
}

const STEP_MESSAGES: ModelMessage[] = [{ role: "assistant", content: "hi" }];
const TEXT: TapeEntry = { kind: "part", part: { type: "text-delta", text: "hi" } };
const TOOL_CALL: TapeEntry = {
  kind: "part",
  part: { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} },
};

describe("partsAsEntries", () => {
  test("wraps every part as a `part` entry, in order", async () => {
    const parts: StreamPart[] = [{ type: "text-delta", text: "a" }, { type: "finish" }];
    const entries: TapeEntry[] = [];
    for await (const entry of partsAsEntries(fromArray(parts))) entries.push(entry);
    expect(entries).toEqual(parts.map((part) => ({ kind: "part", part })));
  });
});

describe("drainEntries", () => {
  test("an ordinary run hands every part to the handler, tool calls included", async () => {
    const handler = recordingHandler();
    const result = await drainEntries(fromArray([TEXT, TOOL_CALL]), handler, {
      adopted: false,
      signal: new AbortController().signal,
      collected: [],
    });
    expect(handler.parts.map((p) => p.type)).toEqual(["text-delta", "tool-call"]);
    expect(result).toEqual({ lateToolCall: false, spokeBeforeRestart: true });
  });

  test("an adopted run stops AT a tool call, reporting what it had already said", async () => {
    const handler = recordingHandler();
    const trace = { onPart: vi.fn() };
    const result = await drainEntries(fromArray([TEXT, TOOL_CALL, TEXT]), handler, {
      adopted: true,
      signal: new AbortController().signal,
      collected: [],
      trace,
    });
    expect(handler.parts.map((p) => p.type)).toEqual(["text-delta"]);
    expect(result).toEqual({ lateToolCall: true, spokeBeforeRestart: true });
    // The late tool call is still timed, though the handler never sees it.
    expect(trace.onPart.mock.calls.map(([type]) => type)).toEqual(["text-delta", "tool-call"]);
  });

  test("a step marker collects its messages and fires onStepPersisted in place", async () => {
    const handler = recordingHandler();
    const collected: ModelMessage[] = [];
    const order: string[] = [];
    handler.handle = (part) => order.push(part.type);
    await drainEntries(
      fromArray<TapeEntry>([TEXT, { kind: "step", messages: STEP_MESSAGES }, TEXT]),
      handler,
      {
        adopted: false,
        signal: new AbortController().signal,
        collected,
        onStepPersisted: () => order.push("step"),
      },
    );
    expect(order).toEqual(["text-delta", "step", "text-delta"]);
    expect(collected).toEqual(STEP_MESSAGES);
  });

  test("an aborted signal stops the drain before the next entry", async () => {
    const handler = recordingHandler();
    const ctl = new AbortController();
    ctl.abort();
    const result = await drainEntries(fromArray([TEXT]), handler, {
      adopted: false,
      signal: ctl.signal,
      collected: [],
    });
    expect(handler.parts).toEqual([]);
    expect(result).toEqual({ lateToolCall: false, spokeBeforeRestart: false });
  });
});
