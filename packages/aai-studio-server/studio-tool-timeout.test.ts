// Copyright 2026 the AAI authors. MIT license.
// A hung tool call (dead sandbox RPC, stalled web fetch) used to hang the
// whole chat turn — the UI shimmered forever with nothing to cancel. The
// deadline wrapper turns that into an ordinary tool-result error.

import { type Tool, tool } from "ai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STUDIO_TOOL_TIMEOUT_MS,
  studioToolTimeoutMs,
  withToolTimeouts,
} from "./studio-tool-timeout.ts";

/** The ai SDK's ToolCallOptions arg — tests only need the required fields. */
function toolOpts() {
  return { toolCallId: "call-1", messages: [], context: undefined as never };
}

function hangingTool() {
  return tool({
    description: "never settles",
    inputSchema: z.object({}),
    execute: () => new Promise<string>(() => undefined),
  });
}

describe("withToolTimeouts", () => {
  test("a call that never settles resolves to a timeout error result", async () => {
    const tools = withToolTimeouts({ hang: hangingTool() }, 20);
    const out = await tools.hang.execute?.({}, toolOpts());
    expect(out).toContain("hang timed out after 0.02s");
    expect(out).toContain("Do not assume it succeeded");
  });

  test("a fast call passes its result through untouched", async () => {
    const tools = withToolTimeouts(
      {
        quick: tool({
          description: "fast",
          inputSchema: z.object({}),
          execute: async () => "done",
        }),
      },
      1000,
    );
    expect(await tools.quick.execute?.({}, toolOpts())).toBe("done");
  });

  test("a rejection inside the deadline still rejects (not converted to text)", async () => {
    const tools = withToolTimeouts(
      {
        boom: tool({
          description: "throws",
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("exploded");
          },
        }),
      },
      1000,
    );
    await expect(tools.boom.execute?.({}, toolOpts())).rejects.toThrow("exploded");
  });

  test("a rejection after the deadline fired does not become an unhandled rejection", async () => {
    let rejectLate: (err: Error) => void = () => undefined;
    const tools = withToolTimeouts(
      {
        late: tool({
          description: "rejects after timing out",
          inputSchema: z.object({}),
          execute: () =>
            new Promise<string>((_, reject) => {
              rejectLate = reject;
            }),
        }),
      },
      10,
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const out = await tools.late.execute?.({}, toolOpts());
      expect(out).toContain("timed out");
      rejectLate(new Error("too late"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("tools without an execute pass through unwrapped", () => {
    const clientSide: Tool = tool({ description: "client-executed", inputSchema: z.object({}) });
    const tools = withToolTimeouts({ relay: clientSide }, 10);
    expect(tools.relay).toBe(clientSide);
  });
});

describe("studioToolTimeoutMs", () => {
  test("defaults when unset or invalid, honors a positive override", () => {
    expect(studioToolTimeoutMs({})).toBe(DEFAULT_STUDIO_TOOL_TIMEOUT_MS);
    expect(studioToolTimeoutMs({ STUDIO_TOOL_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_STUDIO_TOOL_TIMEOUT_MS,
    );
    expect(studioToolTimeoutMs({ STUDIO_TOOL_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_STUDIO_TOOL_TIMEOUT_MS,
    );
    expect(studioToolTimeoutMs({ STUDIO_TOOL_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_STUDIO_TOOL_TIMEOUT_MS,
    );
    expect(studioToolTimeoutMs({ STUDIO_TOOL_TIMEOUT_MS: "30000" })).toBe(30_000);
  });
});
