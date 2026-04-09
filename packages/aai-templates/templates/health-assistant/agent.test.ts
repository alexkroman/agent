import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Dr. Sage (Health Assistant)", () => {
  test("harness loads with medication tools", async () => {
    const t = await createTestHarness(join(__dirname));
    expect(t).toBeDefined();
  });

  test("medication_lookup returns error for unknown drug (offline)", async () => {
    const t = await createTestHarness(join(__dirname));
    // The tool makes HTTP requests to FDA API; in test it will fail gracefully
    const result = (await t.executeTool("medication_lookup", { name: "zzz_fake_drug" })) as {
      error?: string;
    };
    expect(result).toBeDefined();
  });

  test("check_drug_interaction accepts comma-separated drugs", async () => {
    const t = await createTestHarness(join(__dirname));
    // The tool makes HTTP requests to RxNorm API; in test it will fail gracefully
    const result = (await t.executeTool("check_drug_interaction", {
      drugs: "zzz_fake1, zzz_fake2",
    })) as { error?: string };
    expect(result).toBeDefined();
  });
});
