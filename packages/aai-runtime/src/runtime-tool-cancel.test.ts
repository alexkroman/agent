// Copyright 2026 the AAI authors. MIT license.
// Runtime-level tool cancellation: the turn's abort signal must flow from
// ExecuteToolOptions through executeToolCall into ctx.signal, and settle
// hung tools. (Lives outside runtime.test.ts, which is at its ceiling.)

import { describe, expect, test, vi } from "vitest";
import { makeAgent, makeTool, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

describe("runtime executeTool — cancellation (self-hosted tools)", () => {
  test("ctx.signal follows the turn signal", async () => {
    // ctx.signal is a per-call signal chained to the turn's (so a tool
    // timeout can fire it too — see tool-executor.ts); aborting the turn
    // signal must still reach the tool.
    let seen: AbortSignal | undefined;
    const gate = Promise.withResolvers<string>();
    const runtime = createRuntime({
      agent: makeAgent({
        tools: {
          probe: makeTool({
            execute: (_args, ctx) => {
              seen = ctx.signal;
              return gate.promise;
            },
          }),
        },
      }),
      env: {},
      logger: silentLogger,
    });

    const controller = new AbortController();
    const running = runtime.executeTool("probe", {}, "sid", [], {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    gate.resolve("ok");
    await running;
  });

  test("aborting the signal settles a hung tool with a tool error", async () => {
    const runtime = createRuntime({
      agent: makeAgent({
        tools: {
          hang: makeTool({
            execute: () =>
              new Promise<never>(() => {
                /* never resolves */
              }),
          }),
        },
      }),
      env: {},
      logger: silentLogger,
    });

    const controller = new AbortController();
    const promise = runtime.executeTool("hang", {}, "sid", [], { signal: controller.signal });
    controller.abort();
    const result = await promise;
    // Depending on whether the abort lands before or during execution, the
    // executor answers with its short-circuit or the AbortError message —
    // either way the call settles instead of hanging.
    expect(JSON.parse(result)).toMatchObject({ error: expect.stringMatching(/cancel|abort/i) });
  });
});
