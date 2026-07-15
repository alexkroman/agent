// Copyright 2026 the AAI authors. MIT license.
// Runtime-level tool cancellation: the turn's abort signal must flow from
// ExecuteToolOptions through executeToolCall into ctx.signal, and settle
// hung tools. (Lives outside runtime.test.ts, which is at its ceiling.)

import { describe, expect, test } from "vitest";
import { makeAgent, makeTool, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

describe("runtime executeTool — cancellation (self-hosted tools)", () => {
  test("exposes the turn signal as ctx.signal", async () => {
    let seen: AbortSignal | undefined;
    const runtime = createRuntime({
      agent: makeAgent({
        tools: {
          probe: makeTool({
            execute: (_args, ctx) => {
              seen = ctx.signal;
              return "ok";
            },
          }),
        },
      }),
      env: {},
      logger: silentLogger,
    });

    const controller = new AbortController();
    const result = await runtime.executeTool("probe", {}, "sid", [], {
      signal: controller.signal,
    });
    expect(result).toBe("ok");
    expect(seen).toBe(controller.signal);
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
