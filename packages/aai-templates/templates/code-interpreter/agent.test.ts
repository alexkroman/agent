import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirTestHarness } from "@alexkroman1/aai/testing-v2";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Coda (Code Interpreter)", () => {
  test("harness loads without errors", async () => {
    const t = await createDirTestHarness(join(__dirname));
    expect(t).toBeDefined();
  });
});
