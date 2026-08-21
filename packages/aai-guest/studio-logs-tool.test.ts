// Copyright 2026 the AAI authors. MIT license.
/**
 * `read_logs` from the model's side: what it asks the host for, and what it
 * says back. Every case goes through `runTool`, because the SDK's executor is
 * what shapes a validation failure or a throw into something a model can read.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { installFakeHostChannel, runTool } from "./_test-utils.ts";
import { setHostSend } from "./harness-rpc.ts";
import { createLogsTool } from "./studio-logs-tool.ts";

const tools = createLogsTool();

type Line = { seq: number; at: number; stream: "stdout" | "stderr"; text: string };

/** A fixed wall-clock, so the rendered timestamps are the same everywhere. */
const AT = new Date(2026, 0, 2, 3, 4, 5, 678).getTime();

function line(seq: number, text: string, stream: Line["stream"] = "stdout"): Line {
  return { seq, at: AT + seq, stream, text };
}

afterEach(() => {
  setHostSend(null);
});

/** Run the tool against one canned host answer, and return what the model sees. */
async function readLogs(
  args: Record<string, unknown>,
  answer: unknown,
  error?: { code: number; message: string },
): Promise<{ output: string; request: { method: string; params?: unknown } }> {
  const host = installFakeHostChannel();
  const pending = runTool(tools, "read_logs", args);
  // Validation and coercion run before the RPC leaves, so wait for the frame
  // rather than for a fixed number of microtasks.
  await vi.waitFor(() => {
    // A throw rather than an `expect`: this helper is not itself a test, and
    // biome's noMisplacedAssertion is right that an assertion here would be.
    if (host.sent.length === 0) throw new Error("no RPC frame yet");
  });
  const request = host.lastRequest();
  host.answerLast(answer, error);
  return { output: String(await pending), request };
}

describe("read_logs", () => {
  test("asks the host for an ENVIRONMENT, never a slug", async () => {
    const { request } = await readLogs(
      { environment: "production", limit: 25 },
      { slug: "proj", running: true, lines: [line(0, "hi")], dropped: 0, total: 1 },
    );
    expect(request.method).toBe("studio/agent-logs");
    expect(request.params).toEqual({ environment: "production", limit: 25 });
  });

  test("defaults to the preview agent — the one the agent's own edits deploy", async () => {
    const { request } = await readLogs(
      {},
      { slug: "proj-preview", running: true, lines: [line(0, "hi")], dropped: 0, total: 1 },
    );
    expect(request.params).toEqual({ environment: "preview" });
  });

  test("renders the tail with stderr called out, newest last", async () => {
    const { output } = await readLogs(
      {},
      {
        slug: "proj-preview",
        running: true,
        lines: [line(8, "handling call"), line(9, "TypeError: x is not a function", "stderr")],
        dropped: 0,
        total: 40,
      },
    );
    expect(output).toContain("proj-preview (preview) — running, showing the last 2 of 40 line(s)");
    expect(output).toContain("03:04:05.686      handling call");
    expect(output).toContain("03:04:05.687 ERR  TypeError: x is not a function");
  });

  test("a gap in the ring is reported, never swallowed", async () => {
    const { output } = await readLogs(
      {},
      { slug: "proj-preview", running: true, lines: [line(0, "a")], dropped: 12, total: 1 },
    );
    expect(output).toContain("12 earlier line(s) fell out");
  });

  /**
   * Three empty states, three different next moves — which is the whole reason
   * `running` and `slug` are on the wire beside the lines.
   */
  test("empty tells the agent WHICH empty it is", async () => {
    const never = await readLogs({}, { running: false, lines: [], dropped: 0, total: 0 });
    expect(never.output).toContain("No preview agent has been deployed yet");

    const unpublished = await readLogs(
      { environment: "production" },
      { running: false, lines: [], dropped: 0, total: 0 },
    );
    expect(unpublished.output).toContain("never been published");

    const asleep = await readLogs(
      {},
      { slug: "proj-preview", running: false, lines: [], dropped: 0, total: 0 },
    );
    expect(asleep.output).toContain("is not running");

    const quiet = await readLogs(
      {},
      { slug: "proj-preview", running: true, lines: [], dropped: 0, total: 0 },
    );
    expect(quiet.output).toContain("has printed nothing");
  });

  test("a rejected RPC reads as prose the model can act on, not a failed turn", async () => {
    const { output } = await readLogs({}, undefined, {
      code: -32_000,
      message: "This session cannot read the project's agent logs",
    });
    expect(output).toContain("could not read the preview agent's logs");
    expect(output).toContain("cannot read the project's agent logs");
  });

  test("a host answer that is not a log page degrades rather than throwing", async () => {
    const { output } = await readLogs({}, { unexpected: true });
    expect(output).toBe("Error: the platform returned an unreadable log page.");
  });

  test("an out-of-range limit is refused by the schema, before any RPC", async () => {
    const host = installFakeHostChannel();
    const out = String(await runTool(tools, "read_logs", { limit: 5000 }));
    expect(JSON.parse(out)).toMatchObject({ error: expect.any(String) });
    expect(host.sent).toEqual([]);
  });
});
