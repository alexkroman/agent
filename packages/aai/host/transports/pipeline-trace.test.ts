// Copyright 2026 the AAI authors. MIT license.
// Specs for the pipeline transport's STT→LLM debug trace. The trace exists so
// an operator can answer "what text did the LLM actually receive for this
// turn?" from a log — the question that separates an STT recognition miss from
// a turn-aggregation bug when an agent calls a tool with an argument the user
// never said. Enabled by AAI_DEBUG=1 (see runtime-config.debugLoggingEnabled).

import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../runtime-config.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

function makeSpyLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Every `log.debug` message + context pair, in call order. */
function debugCalls(logger: Logger): [string, unknown][] {
  return (logger.debug as unknown as { mock: { calls: [string, unknown][] } }).mock.calls;
}

describe("PipelineTransport — STT debug trace", () => {
  test("traces each STT final as it arrives, with its text", async () => {
    const logger = makeSpyLogger();
    const { opts, stt } = makeOpts({ logger });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("track my order PO999");
    await vi.waitFor(() => {
      expect(debugCalls(logger)).toEqual(
        expect.arrayContaining([
          ["Pipeline STT final", expect.objectContaining({ text: "track my order PO999" })],
        ]),
      );
    });
    await t.stop();
  });

  test("traces the committed turn text — what the LLM is prompted with", async () => {
    // Endpoint settling lives in the STT provider, so the transport commits the
    // final it is handed. Tracing both ends anyway is what makes the split
    // diagnosable: a commit that matches the finals puts a missing word
    // upstream of the transport, in STT or its settler.
    const logger = makeSpyLogger();
    const { opts, stt } = makeOpts({ logger });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("search for a gaming mouse and track my order PO999.");
    await vi.waitFor(() => {
      expect(debugCalls(logger)).toEqual(
        expect.arrayContaining([
          [
            "Pipeline turn committed",
            expect.objectContaining({
              text: "search for a gaming mouse and track my order PO999.",
            }),
          ],
        ]),
      );
    });
    await t.stop();
  });

  test("traces interim transcripts, so a word STT heard then dropped is visible", async () => {
    // The diagnostic case: "PO999" appears in a partial but not in any final.
    // Without partial tracing that loss is invisible in the log.
    const logger = makeSpyLogger();
    const { opts, stt } = makeOpts({ logger });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.firePartial("track my order PO999");
    await vi.waitFor(() => {
      expect(debugCalls(logger)).toEqual(
        expect.arrayContaining([
          ["Pipeline STT partial", expect.objectContaining({ text: "track my order PO999" })],
        ]),
      );
    });
    await t.stop();
  });

  test("every trace entry carries the session id", async () => {
    const logger = makeSpyLogger();
    const { opts, stt } = makeOpts({ logger });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello.");
    await vi.waitFor(() => {
      const traced = debugCalls(logger).filter(([msg]) => msg.startsWith("Pipeline STT"));
      expect(traced.length).toBeGreaterThan(0);
      for (const [, ctx] of traced) expect(ctx).toMatchObject({ sid: "test-sid" });
    });
    await t.stop();
  });
});
