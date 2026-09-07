import { expect, test } from "vitest";
import { z } from "zod";

test("probe", () => {
  const s = z.object({ a: z.string() });
  console.log(
    "instance toJSONSchema?",
    typeof (s as never as Record<string, unknown>).toJSONSchema,
  );
  console.log(
    "instance toJsonSchema?",
    typeof (s as never as Record<string, unknown>).toJsonSchema,
  );
  console.log("z.toJSONSchema ok:", JSON.stringify(z.toJSONSchema(s)).slice(0, 120));
  expect(true).toBe(true);
});
