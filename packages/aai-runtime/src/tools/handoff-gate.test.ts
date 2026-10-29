// Copyright 2026 the AAI authors. MIT license.
import type { Message, ToolEffect } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { isFailedToolResult } from "../_prepare-step.ts";
import { HANDOFF_NOT_MADE_RESULT, handoffToolNames, withHandoffGate } from "./handoff-gate.ts";

const tool = (name: string, effect?: ToolEffect): ToolSchema => ({
  type: "function",
  name,
  description: name,
  parameters: { type: "object" },
  ...omitUndefined({ effect }),
});
const SCHEMAS = [tool("get_order", "read"), tool("cancel", "write"), tool("transfer", "handoff")];
const said = (...turns: string[]): Message[] =>
  turns.flatMap((content) => [
    { role: "user", content },
    { role: "assistant", content: "…" },
  ]);

function gate() {
  const inner = vi.fn(async () => "transferred");
  const exec = withHandoffGate(inner, { schemas: SCHEMAS, log: makeLogger(), sid: "s1" });
  return { exec, inner };
}

describe("withHandoffGate", () => {
  test('only tools declared effect: "handoff" are handoffs', () => {
    expect([...handoffToolNames(SCHEMAS)]).toEqual(["transfer"]);
  });

  test("an unrequested handoff is refused as an ordinary result, and nothing runs", async () => {
    const { exec, inner } = gate();
    const result = await exec("transfer", {}, "s1", said("Isn't there another way to look me up?"));
    expect(result).toBe(HANDOFF_NOT_MADE_RESULT);
    expect(inner).not.toHaveBeenCalled();
    // Not an `Error…`: the failed-call memo must not refuse the second attempt.
    expect(isFailedToolResult(result)).toBe(false);
  });

  test("a caller who asked for a person in either of their last two turns is transferred at once", async () => {
    const { exec, inner } = gate();
    await exec("transfer", {}, "s1", said("Can I just talk to someone who can fix this?", "No."));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  test("an older request has expired", async () => {
    const { exec, inner } = gate();
    await exec(
      "transfer",
      {},
      "s1",
      said("Get me a supervisor.", "Okay.", "Fine, my zip is 10001."),
    );
    expect(inner).not.toHaveBeenCalled();
  });

  test("a second attempt after the caller spoke again goes through; the same turn does not", async () => {
    const { exec, inner } = gate();
    const history = said("That doesn't work for me.");
    await exec("transfer", {}, "s1", history);
    await exec("transfer", {}, "s1", history);
    expect(inner).not.toHaveBeenCalled();
    await exec("transfer", {}, "s1", [...history, ...said("No, I still want the credit card.")]);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  test("other tools pass straight through, and no handoff declared means no wrapper", async () => {
    const { exec, inner } = gate();
    await exec("cancel", {}, "s1", said("yes"));
    expect(inner).toHaveBeenCalledTimes(1);
    const bare = vi.fn(async () => "x");
    expect(
      withHandoffGate(bare, { schemas: [tool("transfer")], log: makeLogger(), sid: "s" }),
    ).toBe(bare);
  });
});
