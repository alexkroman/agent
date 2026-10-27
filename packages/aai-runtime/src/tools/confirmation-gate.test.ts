// Copyright 2026 the AAI authors. MIT license.
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { isFailedToolResult } from "../_prepare-step.ts";
import {
  UNCONFIRMED_WRITE_RESULT,
  withConfirmationGate,
  writeToolNames,
} from "./confirmation-gate.ts";

const tool = (name: string, readOnlyHint?: boolean): ToolSchema => ({
  type: "function",
  name,
  description: name,
  parameters: { type: "object" },
  ...omitUndefined({ annotations: readOnlyHint === undefined ? undefined : { readOnlyHint } }),
});
const SCHEMAS = [tool("get_order", true), tool("return_items", false), tool("transfer")];

function gate(overlapped: boolean) {
  const inner = vi.fn(async () => "done");
  const log = makeLogger();
  const exec = withConfirmationGate(inner, {
    schemas: SCHEMAS,
    turnOverlapped: () => overlapped,
    log,
    sid: "s1",
  });
  return { exec, inner, log };
}

describe("withConfirmationGate", () => {
  test("only tools declared readOnlyHint: false are writes", () => {
    expect([...writeToolNames(SCHEMAS)]).toEqual(["return_items"]);
  });

  test("a write on a turn spoken over the agent is refused, and nothing runs", async () => {
    const { exec, inner, log } = gate(true);
    expect(await exec("return_items", { id: 1 })).toBe(UNCONFIRMED_WRITE_RESULT);
    expect(inner).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map(([m]) => m)).toContain(
      "Pipeline write refused: turn spoke over the agent",
    );
  });

  test("reads and unannotated tools still run on that turn", async () => {
    const { exec, inner } = gate(true);
    expect(await exec("get_order", {})).toBe("done");
    expect(await exec("transfer", {})).toBe("done");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  test("a write on a turn spoken into silence runs", async () => {
    const { exec, inner } = gate(false);
    expect(await exec("return_items", { id: 1 })).toBe("done");
    expect(inner).toHaveBeenCalledOnce();
  });

  // The failed-call memo refuses an identical call that FAILED. The refusal
  // must not read as one, or the confirmed retry would be refused too.
  test("the refusal is not a failure the memo would remember", () => {
    expect(isFailedToolResult(UNCONFIRMED_WRITE_RESULT)).toBe(false);
  });

  test("with no declared writes the executor is returned untouched", () => {
    const inner = vi.fn(async () => "x");
    const exec = withConfirmationGate(inner, {
      schemas: [tool("a"), tool("b", true)],
      turnOverlapped: () => true,
      log: makeLogger(),
      sid: "s1",
    });
    expect(exec).toBe(inner);
  });
});
