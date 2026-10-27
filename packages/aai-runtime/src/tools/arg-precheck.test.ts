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

// tau2 retail's address, descriptions as the host sends them.
const ADDRESS: JSONSchema7 = {
  type: "object",
  properties: {
    address1: {
      type: "string",
      description: "The first line of the address, such as '123 Main St'.",
    },
    address2: {
      type: "string",
      description: "The second line of the address, such as 'Apt 1' or ''.",
    },
  },
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

  test("an EMPTY required string the parameter says can be empty is not refused", () => {
    // tau2's address2: "" is "no second line", and the call succeeds.
    expect(
      precheckToolArgs("modify_address", { address1: "1 Main St", address2: "" }, ADDRESS),
    ).toBeUndefined();
    const listed: JSONSchema7 = {
      type: "object",
      properties: { suite: { type: "string", enum: ["", "A", "B"] } },
      required: ["suite"],
    };
    expect(precheckToolArgs("t", { suite: "" }, listed)).toBeUndefined();
  });

  // tau2 retail: `find_user_id_by_email({ email: " " })` and `last_name: ""`
  // went to the client and came back "User not found".
  test("an empty or whitespace required string is otherwise refused as not given", () => {
    const blank = refusalOf(
      precheckToolArgs(
        "find_user_id_by_name_zip",
        { first_name: "Yusuf", last_name: "", zip: "19122" },
        FIND_BY_NAME_ZIP,
      ),
    );
    expect(blank.error).toContain('"last_name" required, not given');
    expect(blank.reason).toBe("invalid_arguments");
    const spaces = refusalOf(
      precheckToolArgs(
        "find_user_id_by_name_zip",
        { first_name: " ", last_name: "Rossi", zip: "19122" },
        FIND_BY_NAME_ZIP,
      ),
    );
    expect(spaces.error).toContain('"first_name" required, not given');
    expect(
      precheckToolArgs("modify_address", { address1: "", address2: "" }, ADDRESS),
    ).toBeDefined();
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
