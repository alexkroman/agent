// Copyright 2026 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { expectDialogOk } from "./_testing-tool-results.ts";
import type { DialogToolResult } from "./dialog-types.ts";
import type { ToolFailure } from "./utils.ts";

test("expectDialogOk infers the envelope through the ToolFailure arm a gated run answers", () => {
  const answered = expectDialogOk({} as DialogToolResult<{ quoted: number }> | ToolFailure);
  expectTypeOf(answered.result).toEqualTypeOf<{ quoted: number }>();
  const plain = expectDialogOk({} as DialogToolResult<{ quoted: number }>);
  expectTypeOf(plain.result).toEqualTypeOf<{ quoted: number }>();
});
