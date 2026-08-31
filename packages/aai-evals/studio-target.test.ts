// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio target's stream reading, driven with canned SSE.
 *
 * `readTurn` is the only seam in `studio-target.ts` a unit test can reach — the
 * rest needs a live studio, a real sandbox and a model, which is why that module
 * sits outside this package's coverage floors. It is also the half where a break
 * is SILENT: every grading check in `starter.eval.test.ts` reads a field of
 * `StudioTurn`, so a part-shape the AI SDK renamed folds to an empty turn, and an
 * empty turn grades as a coding agent that did nothing rather than as a broken
 * harness. Nothing else in the repo would say otherwise.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { readTurn } from "./studio-target.ts";

/** One `data:` frame per argument, as the guest's chat endpoint writes them. */
function sse(...frames: unknown[]): string {
  return frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
}

/** A body that delivers `text` in `size`-byte pieces. */
function body(text: string, size = 4096): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

/** One tool call, start to output, as three frames. */
function toolCall(id: string, name: string, output: string): unknown[] {
  return [
    { type: "tool-input-start", toolCallId: id, toolName: name },
    { type: "tool-input-available", toolCallId: id, toolName: name, input: {} },
    { type: "tool-output-available", toolCallId: id, output },
  ];
}

/**
 * `test_agent`'s real success shape, from `formatLoadedSummary`
 * (aai-guest/studio-tools.ts). Copied rather than invented: the excerpt
 * preamble and `parseLoadedConfig` are both regexes over THIS sentence, so a
 * fixture that only looks like it proves nothing about either.
 */
const LOADED_SUMMARY =
  'Bundle loaded in the sandbox. Agent "Pizza Line" (pipeline mode), tools: add_pizza.';
const GREEN_TEST_AGENT = `${LOADED_SUMMARY} Tests: PASSED`;

/**
 * A red write result, from `formatPostWriteDiagnostics`
 * (aai-guest/studio-write-diagnostics.ts) — a fixed ~165-character instruction
 * in front of the diagnostics, which is the whole reason the excerpt strips it.
 */
const writeDiagnostics = (rel: string, output: string): string =>
  `\n\nType errors after writing ${rel} — the file WAS saved (do not re-send it ` +
  `unchanged); fix these before running test_agent:\n${output}`;

describe("readTurn", () => {
  test("records tool calls in the order they were made", async () => {
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          ...toolCall("c1", "write_file", "wrote agent.ts"),
          ...toolCall("c2", "check_types", "no errors"),
          ...toolCall("c3", "test_agent", GREEN_TEST_AGENT),
          { type: "finish" },
        ),
      ),
    );
    expect(turn.toolCalls).toEqual(["write_file", "check_types", "test_agent"]);
  });

  test("a test_agent run is classified and its output kept for the config read", async () => {
    const turn = await readTurn(
      body(sse({ type: "start" }, ...toolCall("c1", "test_agent", GREEN_TEST_AGENT))),
    );
    expect(turn.testAgentRuns).toHaveLength(1);
    expect(turn.testAgentRuns[0]?.buildFailed).toBe(false);
    expect(turn.testAgentRuns[0]?.testsFailed).toBe(false);
    // `parseLoadedConfig` reads this; an empty string is a silently ungraded case.
    expect(turn.lastTestAgentOutput).toBe(GREEN_TEST_AGENT);
  });

  test("a failed run is classified and the success preamble stripped from the excerpt", async () => {
    const out = `${LOADED_SUMMARY} Tests: FAILED — cart total wrong`;
    const turn = await readTurn(body(sse({ type: "start" }, ...toolCall("c1", "test_agent", out))));
    expect(turn.testAgentRuns[0]?.testsFailed).toBe(true);
    // The preamble grows with the agent's tool list; an excerpt taken before
    // stripping it is boilerplate plus one truncated error.
    expect(turn.testAgentRuns[0]?.excerpt).not.toMatch(/Bundle loaded/);
    expect(turn.testAgentRuns[0]?.excerpt).toMatch(/cart total wrong/);
  });

  test("a red verification is counted whichever tool ran it", async () => {
    // Counting only test_agent makes the metric movable by REORDERING tools.
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          ...toolCall("c1", "write_file", writeDiagnostics("agent.ts", "error TS2345: nope")),
          ...toolCall("c2", "check_types", "error TS1005: ';' expected"),
          ...toolCall("c3", "list_files", "error TS9999 mentioned in a filename"),
        ),
      ),
    );
    expect(turn.redChecks).toEqual(["write_file", "check_types"]);
    // The fixed instruction preamble is replaced by the file it names, so the
    // excerpt keeps the diagnostic rather than the boilerplate.
    expect(turn.redExcerpts[0]).toMatch(/^write_file: agent\.ts: error TS2345/);
  });

  test("text deltas accumulate into the turn's text", async () => {
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Built " },
          { type: "text-delta", id: "t1", delta: "the cart." },
          { type: "text-end", id: "t1" },
        ),
      ),
    );
    expect(turn.text).toBe("Built the cart.");
  });

  test("an error is recorded and the turn RUNS ON", async () => {
    // `terminateOnError: false` is the whole point: a turn cut short at its
    // first error loses every tool call after it, and a partial transcript
    // grades as an agent that stopped working.
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          ...toolCall("c1", "write_file", "ok"),
          { type: "error", errorText: "sandbox went away" },
          ...toolCall("c2", "test_agent", GREEN_TEST_AGENT),
        ),
      ),
    );
    expect(turn.errors).toEqual(["sandbox went away"]);
    expect(turn.toolCalls).toEqual(["write_file", "test_agent"]);
  });

  test("a malformed frame is skipped rather than losing the turn", async () => {
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          "{not json",
          "[DONE]",
          "",
          ...toolCall("c1", "test_agent", GREEN_TEST_AGENT),
        ),
      ),
    );
    expect(turn.toolCalls).toEqual(["test_agent"]);
    expect(turn.errors).toEqual([]);
  });

  test("a frame split across byte chunks still parses", async () => {
    // The `{ stream: true }` decode. A multi-byte character split across two
    // reads is the failure this guards, and an em-dash is two bytes in UTF-8.
    const turn = await readTurn(
      body(
        sse(
          { type: "start" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "built — shipped" },
          { type: "text-end", id: "t1" },
        ),
        1,
      ),
    );
    expect(turn.text).toBe("built — shipped");
  });

  test("a call that never left input-streaming is not counted as made", async () => {
    const turn = await readTurn(
      body(sse({ type: "start" }, { type: "tool-input-start", toolCallId: "c1", toolName: "x" })),
    );
    expect(turn.toolCalls).toEqual([]);
  });

  test("an empty body yields an empty turn rather than throwing", async () => {
    const turn = await readTurn(body(""));
    expect(turn.toolCalls).toEqual([]);
    expect(turn.errors).toEqual([]);
  });
});
