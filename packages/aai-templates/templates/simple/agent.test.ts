import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Simple Assistant", () => {
  test("harness loads without errors", async () => {
    const t = await createTestHarness(join(__dirname));
    expect(t).toBeDefined();
    expect(t.messages).toHaveLength(0);
  });

  test("conversation tracks messages", async () => {
    const t = await createTestHarness(join(__dirname));
    await t.turn("Hello");
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.content).toBe("Hello");
  });
});
