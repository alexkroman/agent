// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";

const generateObjectMock = vi.fn();

// Mock `ai`: stub generateObject + NoSuchToolError.isInstance (a NoSuchTool
// error is marked with `__noSuchTool`); keep everything else (jsonSchema) real.
vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    NoSuchToolError: {
      isInstance: (e: unknown) => (e as { __noSuchTool?: boolean })?.__noSuchTool === true,
    },
  };
});

import { createToolCallRepair } from "./pipeline-repair.ts";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const model = {} as never;

function repairOptions(over: Record<string, unknown> = {}): never {
  return {
    toolCall: { toolCallId: "t1", toolName: "lookup", input: '{"x":"bad"}' },
    tools: {},
    inputSchema: async () => ({ type: "object", properties: { x: { type: "number" } } }),
    error: new Error("x must be a number"),
    ...over,
  } as never;
}

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe("createToolCallRepair", () => {
  test("regenerates valid arguments on a schema-invalid tool call", async () => {
    generateObjectMock.mockResolvedValue({ object: { x: 5 } });
    const repair = createToolCallRepair(model, log);
    const result = await repair(repairOptions());
    expect(generateObjectMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      toolCallId: "t1",
      toolName: "lookup",
      input: JSON.stringify({ x: 5 }),
    });
  });

  test("returns null for an unknown tool without regenerating", async () => {
    const repair = createToolCallRepair(model, log);
    const result = await repair(repairOptions({ error: { __noSuchTool: true } }));
    expect(result).toBeNull();
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  test("returns null (and warns) when regeneration itself fails", async () => {
    generateObjectMock.mockRejectedValue(new Error("model unavailable"));
    const repair = createToolCallRepair(model, log);
    const result = await repair(repairOptions());
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});
