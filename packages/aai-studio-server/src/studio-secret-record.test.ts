// Copyright 2026 the AAI authors. MIT license.
// JSON records in the SecretStore (studio-secret-record.ts): a malformed
// record reads as ABSENT, never as a throw or an unchecked shape.

import { createMemorySecretStore } from "aai-server/stores";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseJsonSecret, readJsonSecret, writeJsonSecret } from "./studio-secret-record.ts";

const LinkSchema = z.object({ installationId: z.number(), account: z.string() });

describe("parseJsonSecret", () => {
  test("returns the document when it matches the schema", () => {
    expect(parseJsonSecret('{"installationId":42,"account":"acme"}', LinkSchema)).toEqual({
      installationId: 42,
      account: "acme",
    });
  });

  test.each([
    ["not JSON", "not json at all"],
    ["the wrong shape", '{"installationId":"42","account":"acme"}'],
    ["a missing field", '{"installationId":42}'],
    ["a JSON scalar", "42"],
  ])("is null for %s", (_label, raw) => {
    expect(parseJsonSecret(raw, LinkSchema)).toBeNull();
  });
});

describe("readJsonSecret / writeJsonSecret", () => {
  test("a written record reads back through its schema", async () => {
    const secrets = createMemorySecretStore();
    await writeJsonSecret(secrets, "github-install:u1", { installationId: 7, account: "a" });
    expect(await secrets.get("github-install:u1")).toBe('{"installationId":7,"account":"a"}');
    expect(await readJsonSecret(secrets, "github-install:u1", LinkSchema)).toEqual({
      installationId: 7,
      account: "a",
    });
  });

  test("an absent record is null", async () => {
    expect(await readJsonSecret(createMemorySecretStore(), "missing", LinkSchema)).toBeNull();
  });

  test("a stored value that is not the record's shape is null", async () => {
    const secrets = createMemorySecretStore();
    await secrets.put("github-install:u1", "{oops");
    expect(await readJsonSecret(secrets, "github-install:u1", LinkSchema)).toBeNull();
  });

  test("writing again replaces the record", async () => {
    const secrets = createMemorySecretStore();
    await writeJsonSecret(secrets, "n", { installationId: 1, account: "old" });
    await writeJsonSecret(secrets, "n", { installationId: 2, account: "new" });
    expect(await readJsonSecret(secrets, "n", LinkSchema)).toEqual({
      installationId: 2,
      account: "new",
    });
  });
});
