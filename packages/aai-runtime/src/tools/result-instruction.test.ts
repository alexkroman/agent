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

describe("splitInstruction below the top level", () => {
  test("a list of withInstruction rows: the key leaves every row, the sentence is said once", () => {
    const rows = [1, 2, 3].map((id) => withInstruction({ id }, "Say one."));
    expect(splitInstruction(JSON.stringify(rows))).toEqual({
      result: '[{"id":1},{"id":2},{"id":3}]',
      instruction: "Say one.",
    });
  });

  test("nested records: stripped at every depth, sentences joined in encounter order", () => {
    const raw = JSON.stringify(
      withInstruction(
        {
          inner: withInstruction(
            { id: 1, deeper: [withInstruction({ n: 2 }, "Third.")] },
            "Second.",
          ),
          after: withInstruction({ ok: true }, "Third."),
        },
        "First.",
      ),
    );
    expect(splitInstruction(raw)).toEqual({
      result: '{"inner":{"id":1,"deeper":[{"n":2}]},"after":{"ok":true}}',
      instruction: "First. Second. Third.",
    });
  });

  test("a non-string under the key is a tool's own data, at any depth", () => {
    const raw = '{"rows":[{"$instruction":42}],"$instruction":{"x":1}}';
    expect(splitInstruction(raw).result).toBe(raw);
    expect(splitInstruction(raw)).not.toHaveProperty("instruction");
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
