import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Scout (Web Researcher)", () => {
  test("harness loads without errors", async () => {
    const t = await createTestHarness(join(__dirname));
    expect(t).toBeDefined();
  });

  test("conversation tracks messages across turns", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.turn("What is TypeScript?");
    await t.turn("Tell me more");
    expect(t.messages).toHaveLength(2);
  });
});
