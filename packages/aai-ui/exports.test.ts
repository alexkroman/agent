import { expect, test } from "vitest";

test("@alexkroman1/aai-ui main export", async () => {
  const mod = await import("@alexkroman1/aai-ui");
  expect(Object.keys(mod).sort()).toMatchSnapshot();
});
