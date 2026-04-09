import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Aria (Travel Concierge)", () => {
  test("harness loads without errors", async () => {
    const t = await createTestHarness(join(__dirname));
    expect(t).toBeDefined();
  });
});
