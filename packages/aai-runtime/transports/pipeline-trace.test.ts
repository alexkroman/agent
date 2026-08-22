// Copyright 2026 the AAI authors. MIT license.
// Specs for the pipeline transport's STT→LLM debug trace. The trace exists so
// an operator can answer "what text did the LLM actually receive for this
// turn?" from a log — the question that separates an STT recognition miss from
// a turn-aggregation bug when an agent calls a tool with an argument the user
// never said. Enabled by AAI_DEBUG=1 (see runtime-config.debugLoggingEnabled).

import { describe, expect, test, vi } from "vitest";
import { makeLogger, tick } from "../_test-utils.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

/**
 * Every `log.debug` message + context pair, in call order.
 *
 * Reads the spy's own call log rather than laundering a `Logger` back into one:
 * this file used to declare a local spy logger typed as `Logger`, which erased
 * the spy type and made a double cast the only way back to `.mock.calls`.
 * `makeLogger()` (the shared one, spy-typed) keeps it a projection.
 */
function debugCalls(logger: ReturnType<typeof makeLogger>): [string, unknown][] {
  return logger.debug.mock.calls.map((call) => [String(call[0]), call[1]]);
}

describe("PipelineTransport — STT debug trace", () => {
  test("traces each STT final as it arrives, with its text", async () => {
    const logger = makeLogger();
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
    const logger = makeLogger();
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

  test("does NOT trace interim transcripts by default — they are opt-in", async () => {
    // Interims are the highest-volume line in a session (one per ~200ms of
    // speech, each a revision of the last) and drowned the turn-level events,
    // so they sit behind AAI_DEBUG_PARTIALS rather than plain AAI_DEBUG.
    //
    // The diagnostic they existed for — a word STT heard in a partial and then
    // dropped from every final — is not lost: the provider's own turn trace
    // still logs it under AAI_DEBUG, with end_of_turn and the end-of-turn
    // confidence alongside (host/providers/stt/assemblyai.test.ts).
    const logger = makeLogger();
    const { opts, stt } = makeOpts({ logger });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.firePartial("track my order PO999");
    await tick();
    expect(debugCalls(logger).map(([msg]) => msg)).not.toContain("Pipeline STT partial");
    await t.stop();
  });

  test("every trace entry carries the session id", async () => {
    const logger = makeLogger();
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
