// Copyright 2026 the AAI authors. MIT license.
import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { emptyArgsNote, precheckToolArgs } from "./arg-precheck.ts";

// tau2 retail's declaration, as the host sends it: no `additionalProperties`.
const FIND_BY_NAME_ZIP: JSONSchema7 = {
  type: "object",
  properties: {
    first_name: { type: "string" },
    last_name: { type: "string" },
    zip: { type: "string" },
  },
  required: ["first_name", "last_name", "zip"],
};

const ADDRESS: JSONSchema7 = {
  type: "object",
  properties: { address1: { type: "string" }, address2: { type: "string" } },
  required: ["address1", "address2"],
};

function refusalOf(text: string | undefined): { error: string; reason: string } {
  // A throw rather than `expect`: biome's `noMisplacedAssertion` reads an
  // assertion outside a test body as a bug.
  if (text === undefined) throw new Error("expected a refusal, got undefined");
  return JSON.parse(text) as { error: string; reason: string };
}

describe("precheckToolArgs", () => {
  test("well-formed arguments run", () => {
    const args = { first_name: "Sofia", last_name: "Li", zip: "78260" };
    expect(precheckToolArgs("find_user_id_by_name_zip", args, FIND_BY_NAME_ZIP)).toBeUndefined();
  });

  test("no declaration, no check", () => {
    expect(precheckToolArgs("anything", { email: "unknown" }, undefined)).toBeUndefined();
  });

  test("task 59's call — the wrong tool's parameter, the right ones missing — is refused", () => {
    // Recorded: this reached the harness and came back as a Python traceback.
    const refusal = refusalOf(
      precheckToolArgs("find_user_id_by_name_zip", { email: "a@b.com" }, FIND_BY_NAME_ZIP),
    );
    expect(refusal.reason).toBe("invalid_arguments");
    expect(refusal.error).toMatch(/^Invalid arguments for tool "find_user_id_by_name_zip"/);
    expect(refusal.error).toContain('"first_name", "last_name", "zip" required, not given');
    expect(refusal.error).toContain('no parameter "email"');
    expect(refusal.error).toContain("takes: first_name, last_name, zip");
    expect(refusal.error).toContain("call that tool");
  });

  test("a stray key alone runs — an authored zod tool strips it — unless the schema is closed", () => {
    const args = { first_name: "A", last_name: "B", zip: "12345", note: "x" };
    expect(precheckToolArgs("t", args, FIND_BY_NAME_ZIP)).toBeUndefined();
    const closed: JSONSchema7 = { ...FIND_BY_NAME_ZIP, additionalProperties: false };
    expect(refusalOf(precheckToolArgs("t", args, closed)).error).toContain('no parameter "note"');
  });

  test("a missing or null required parameter is refused", () => {
    const refusal = refusalOf(
      precheckToolArgs(
        "find_user_id_by_name_zip",
        { first_name: "Mia", zip: null },
        FIND_BY_NAME_ZIP,
      ),
    );
    expect(refusal.error).toContain('"last_name", "zip" required, not given');
    expect(refusal.error).toContain("never fill it with a guess");
  });

  test.each(["unknown", "?", " N/A ", "TBD"])("the placeholder %j is refused", (value) => {
    const args = { first_name: value, last_name: "Patel", zip: "76165" };
    const refusal = refusalOf(precheckToolArgs("find_user_id_by_name_zip", args, FIND_BY_NAME_ZIP));
    expect(refusal.error).toContain(`"first_name" is "${value}"`);
  });

  test("a placeholder word the parameter's own enum lists is an answer", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { status: { type: "string", enum: ["known", "unknown"] } },
      required: ["status"],
    };
    expect(precheckToolArgs("t", { status: "unknown" }, schema)).toBeUndefined();
  });

  test("an EMPTY required string is not refused — it can be a real answer", () => {
    // tau2's address2: "" is "no second line", and the call succeeds.
    expect(
      precheckToolArgs("modify_address", { address1: "1 Main St", address2: "" }, ADDRESS),
    ).toBeUndefined();
  });
});

describe("emptyArgsNote", () => {
  test("names each required string sent empty", () => {
    const args = { first_name: "Sofia", last_name: "Martin", zip: "" };
    expect(emptyArgsNote(args, FIND_BY_NAME_ZIP)).toBe(
      '"zip" was sent empty, so nothing could match. Ask the user for the value rather than retrying without it.',
    );
    expect(emptyArgsNote({ first_name: "", last_name: " ", zip: "1" }, FIND_BY_NAME_ZIP)).toContain(
      '"first_name", "last_name" were sent empty',
    );
  });

  test("nothing empty, or no declaration, says nothing", () => {
    expect(
      emptyArgsNote({ first_name: "A", last_name: "B", zip: "1" }, FIND_BY_NAME_ZIP),
    ).toBeUndefined();
    expect(emptyArgsNote({ zip: "" }, undefined)).toBeUndefined();
  });
});
