// Copyright 2026 the AAI authors. MIT license.
/**
 * The guard that refuses an eval case scripting a tool the agent does not
 * declare, plus its complement — the notice an agent declaring nothing gets.
 *
 * Beside `_declared-tools.ts` rather than in `describe.test.ts`, where these
 * were written: a test next to the module is the only thing that claims
 * anything about the module, since `check:coverage-per-file` can be satisfied
 * incidentally by a spec written for something that merely imports it.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { toolRunner } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  AUTHORED_DEF_HINT,
  announceToollessAgent,
  checkStubReplyTools,
} from "./_declared-tools.ts";

/**
 * The agent as DEPLOYED, and the agent as AUTHORED — the two things a
 * `describeEval(...)` line can be handed, one of which measures nothing.
 */
const lookUpOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
});
const deployed = withTools(agent({ name: "Order Desk" }), { look_up_order: lookUpOrder });
const authored = agent({ name: "Order Desk" });
/** A workflow app's def: no tools, and plainly lowered all the same. */
const reconcile = workflow({ input: z.object({}), run: async () => ({ done: true }) });

describe("checkStubReplyTools", () => {
  /**
   * The mistake this exists for. `agent.ts`'s default export declares no tools,
   * so the scripted model emits a `tool-call` nothing serves and the case dies
   * on `expected [] to contain 'look_up_order'` — dozens of lines from the
   * `describeEval(authored, …)` that caused it.
   */
  test("an authored def refuses the case at DECLARATION, naming the tool and the remedy", () => {
    expect(() =>
      checkStubReplyTools(authored, "looks an order up", [
        { tool: "look_up_order", args: { orderId: "W1234" } },
        "It shipped.",
      ]),
    ).toThrow(/look_up_order.*does not declare.*It declares: \(none\)/s);
  });

  test("and the refusal carries the authored-def hint, which is the actual fix", () => {
    expect(() =>
      checkStubReplyTools(authored, "looks an order up", [{ tool: "look_up_order" }]),
    ).toThrow(new RegExp(escapeRegExp(AUTHORED_DEF_HINT)));
  });

  /**
   * A lowered agent that misses a name is a RENAME or a typo, not the authored
   * def — so the message names what IS declared and points at the file, and
   * the hint about `virtual:aai/agent` would be a non-sequitur.
   */
  test("a lowered agent that misses a name lists the ones it has", () => {
    let message = "";
    try {
      checkStubReplyTools(deployed, "looks an order up", [{ tool: "look_up_ordr" }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("look_up_ordr");
    expect(message).toContain("It declares: look_up_order.");
    expect(message).toContain("tools/look_up_ordr.ts");
    expect(message).not.toContain(AUTHORED_DEF_HINT);
  });

  test("the case's own NAME is in the message — one line of a file declares many", () => {
    expect(() => checkStubReplyTools(deployed, "looks an order up", [{ tool: "nope" }])).toThrow(
      /"looks an order up"/,
    );
  });

  test("a declared tool passes, and so does a plain line and a case scripting nothing", () => {
    expect(() =>
      checkStubReplyTools(deployed, "ok", [
        { tool: "look_up_order", args: { orderId: "W1234" } },
        "It shipped.",
      ]),
    ).not.toThrow();
    expect(() => checkStubReplyTools(authored, "ok", "just a line")).not.toThrow();
    expect(() => checkStubReplyTools(authored, "ok", undefined)).not.toThrow();
  });

  /**
   * The false positive this guard shipped with. A builtin is servable — the
   * model's table is `tools` PLUS `builtinTools`, the union
   * `mergeBuiltinSurface` assembles — and reading only `tools` called every one
   * of them undeclared. Three shipped templates script exactly this shape, and
   * all three went red: `code-interpreter-agent` and `entertainment-picks-agent`
   * on `run_code`, `web-research-agent` on `visit_webpage`.
   */
  test("a builtin the agent declares is servable, so scripting one passes", () => {
    const coder = agent({ name: "Coda", builtinTools: ["run_code"] });
    expect(() =>
      checkStubReplyTools(coder, "works it out in code", [
        { tool: "run_code", args: { code: "1 + 1" } },
        "That's two.",
      ]),
    ).not.toThrow();

    // Both sources at once, and a name in neither still throws.
    const both = withTools(agent({ name: "Desk", builtinTools: ["run_code"] }), {
      look_up_order: lookUpOrder,
    });
    expect(() => checkStubReplyTools(both, "ok", [{ tool: "look_up_order" }])).not.toThrow();
    expect(() => checkStubReplyTools(both, "ok", [{ tool: "run_code" }])).not.toThrow();
    expect(() => checkStubReplyTools(both, "ok", [{ tool: "nope" }])).toThrow(
      /does not declare.*run_code/s,
    );
  });

  /**
   * An MCP server's tools are discovered from the live server by
   * `withMcpTools` at host start, so a lowered def carries none of their names
   * and this check has nothing to compare against. Staying quiet is the only
   * honest answer — the alternative refuses a case that would have passed.
   */
  test("an agent declaring an MCP server is not second-guessed", () => {
    const withMcp = agent({
      name: "Desk",
      mcpServers: { docs: { url: "https://mcp.example.com/sse" } },
    });
    expect(() =>
      checkStubReplyTools(withMcp, "reads the docs", [{ tool: "docs_search" }]),
    ).not.toThrow();
  });
});

describe("announceToollessAgent", () => {
  /**
   * The complement to the throw above, and it may never BE one: a
   * conversational agent with no tools is a legal eval target, and a live run
   * has no script for the throw to inspect. So the tool-less case is announced
   * and runs.
   */
  test("an agent declaring nothing gets a line, on the same channel as the mode", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceToollessAgent(authored);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Order Desk — this agent declares no tools and no workflows"),
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(AUTHORED_DEF_HINT));
  });

  test("an agent with tools is silent", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceToollessAgent(deployed);
    expect(stderr).not.toHaveBeenCalled();
  });

  /**
   * A def carrying workflows has plainly been lowered — the same build writes
   * both — so a tool-less workflow app would get a notice about a mistake it
   * cannot have made.
   */
  test("a workflow app is silent too, having plainly been lowered", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announceToollessAgent(agent({ name: "Runner", workflows: { reconcile } }));
    expect(stderr).not.toHaveBeenCalled();
  });
});

/**
 * The hint is a COPY of the one `toolRunner` throws (`AUTHORED_DEF_HINT` in
 * `packages/aai/src/sdk/testing-tools.ts`), because that one is module-private
 * and reaching it would put a new name on a published subpath. This is what
 * stops the copy drifting: `toolRunner` refuses an agent with no tools at BIND,
 * with that sentence, so its own message is the assertion.
 */
test("the authored-def hint still matches the SDK's, word for word", () => {
  expect(() => toolRunner({ tools: {} })).toThrow(new RegExp(escapeRegExp(AUTHORED_DEF_HINT)));
});

/** `RegExp.escape` is ES2025; this file's target is not there yet. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
