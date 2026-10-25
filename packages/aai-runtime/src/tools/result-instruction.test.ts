// Copyright 2026 the AAI authors. MIT license.
import { withInstruction } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import {
  splitInstruction,
  TOOL_INSTRUCTION_LABEL,
  withInstructionForModel,
} from "./result-instruction.ts";

describe("splitInstruction", () => {
  test("takes the reserved key out of a JSON result and hands the sentence back beside it", () => {
    const raw = JSON.stringify(
      withInstruction({ steps: ["a", "b"] }, "Read it back in one breath."),
    );
    expect(splitInstruction(raw)).toEqual({
      result: '{"steps":["a","b"]}',
      instruction: "Read it back in one breath.",
    });
  });

  test("a result without one — JSON or not — comes back as it was, by identity", () => {
    for (const raw of ['{"ok":true}', "plain text", "null", '["a"]', "{not json"]) {
      const split = splitInstruction(raw);
      expect(split.result).toBe(raw);
      expect(split).not.toHaveProperty("instruction");
    }
  });

  test("a result that does not spell the key is never parsed; one that does is parsed once", () => {
    const parse = vi.fn((text: string) => JSON.parse(text) as unknown);
    for (const raw of ['{"ok":true}', '{"instruction":"not the key"}', "plain $instruction"]) {
      expect(splitInstruction(raw, parse).result).toBe(raw);
    }
    expect(parse).not.toHaveBeenCalled();
    const raw = JSON.stringify(withInstruction({ ok: true }, "Say so."));
    expect(splitInstruction(raw, parse)).toEqual({ result: '{"ok":true}', instruction: "Say so." });
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe("withInstructionForModel", () => {
  test("appends the instruction under its label, blank-line separated, or nothing", () => {
    expect(withInstructionForModel("shaped", "Say the count.")).toBe(
      `shaped\n\n${TOOL_INSTRUCTION_LABEL} Say the count.`,
    );
    expect(withInstructionForModel("shaped", undefined)).toBe("shaped");
  });
});
