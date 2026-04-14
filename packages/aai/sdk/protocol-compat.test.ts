// Copyright 2025 the AAI authors. MIT license.
/**
 * Protocol compatibility tests.
 *
 * These test pinned fixture messages against the current Zod schemas to
 * catch breaking wire-format changes. Unlike snapshot tests, fixtures
 * are never auto-updated — a failure here means deployed code would break.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  MAX_TOOL_RESULT_CHARS,
} from "./constants.ts";
import {
  ClientMessageSchema,
  KvRequestSchema,
  ServerMessageSchema,
  SessionErrorCodeSchema,
} from "./protocol.ts";

// ── Load fixtures ─────────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dirname, "compat-fixtures");
const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

type Fixture = {
  version: number;
  ServerMessage: Record<string, unknown>[];
  ClientMessage: Record<string, unknown>[];
  KvRequest: Record<string, unknown>[];
  constants: {
    DEFAULT_STT_SAMPLE_RATE: number;
    DEFAULT_TTS_SAMPLE_RATE: number;
    MAX_TOOL_RESULT_CHARS: number;
    SessionErrorCodes: string[];
  };
};

function loadFixture(filename: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, filename), "utf-8"));
}

function compatError(fixture: string, schema: string, msg: unknown, zodError: string): string {
  return [
    `PROTOCOL COMPATIBILITY BREAK (${fixture}, ${schema}):`,
    "",
    "A deployed client/server sending this message would fail:",
    `  ${JSON.stringify(msg)}`,
    "",
    `Zod error: ${zodError}`,
    "",
    "To resolve:",
    "  1. If UNINTENTIONAL: revert the schema change.",
    "  2. If INTENTIONAL: create a new fixture version and document the breaking change.",
  ].join("\n");
}

/**
 * Check if a discriminated union schema accepts a given discriminant value
 * by testing whether a minimal object with that value passes the first
 * discriminant check (the full parse may fail, but the type/op is recognized).
 */
function schemaAcceptsType(
  schema: typeof ServerMessageSchema | typeof ClientMessageSchema,
  type: string,
): boolean {
  // Parse a minimal object with just the discriminant. If the discriminant
  // is unrecognized, the error includes "invalid_union_discriminator" or
  // similar. Any other failure (missing fields) means the variant exists.
  const result = schema.safeParse({ type });
  if (result.success) return true;
  // Check error messages — the Zod issue code for discriminated union
  // mismatches varies across versions, so we check the message text.
  return !result.error.issues.some((i) => i.message.includes("Invalid discriminator"));
}

function kvSchemaAcceptsOp(op: string): boolean {
  const result = KvRequestSchema.safeParse({ op });
  if (result.success) return true;
  return !result.error.issues.some((i) => i.message.includes("Invalid discriminator"));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.each(fixtureFiles)("compat fixture: %s", (filename) => {
  const fixture = loadFixture(filename);

  // ── Backward compat: every fixture message must still parse ──────

  describe("ServerMessage backward compat", () => {
    test.each(
      fixture.ServerMessage.map((m, i) => [`${(m as { type: string }).type}#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = ServerMessageSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "ServerMessage", msg, result.error.message));
      }
    });
  });

  describe("ClientMessage backward compat", () => {
    test.each(
      fixture.ClientMessage.map((m, i) => [`${(m as { type: string }).type}#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = ClientMessageSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "ClientMessage", msg, result.error.message));
      }
    });
  });

  describe("KvRequest backward compat", () => {
    test.each(
      fixture.KvRequest.map((m, i) => [`${(m as { op: string }).op}#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = KvRequestSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "KvRequest", msg, result.error.message));
      }
    });
  });

  // ── Variant coverage: no types/ops removed ──────────────────────

  describe("variant coverage", () => {
    test("no ServerMessage types removed", () => {
      const fixtureTypes = new Set(fixture.ServerMessage.map((m) => (m as { type: string }).type));
      for (const t of fixtureTypes) {
        expect(
          schemaAcceptsType(ServerMessageSchema, t),
          `ServerMessage variant "${t}" was removed`,
        ).toBe(true);
      }
    });

    test("no ClientMessage types removed", () => {
      const fixtureTypes = new Set(fixture.ClientMessage.map((m) => (m as { type: string }).type));
      for (const t of fixtureTypes) {
        expect(
          schemaAcceptsType(ClientMessageSchema, t),
          `ClientMessage variant "${t}" was removed`,
        ).toBe(true);
      }
    });

    test("no KvRequest ops removed", () => {
      const fixtureOps = new Set(fixture.KvRequest.map((m) => (m as { op: string }).op));
      for (const op of fixtureOps) {
        expect(kvSchemaAcceptsOp(op), `KvRequest op "${op}" was removed`).toBe(true);
      }
    });
  });

  // ── Constants stability ─────────────────────────────────────────

  describe("constants stability", () => {
    test("DEFAULT_STT_SAMPLE_RATE unchanged", () => {
      expect(DEFAULT_STT_SAMPLE_RATE).toBe(fixture.constants.DEFAULT_STT_SAMPLE_RATE);
    });

    test("DEFAULT_TTS_SAMPLE_RATE unchanged", () => {
      expect(DEFAULT_TTS_SAMPLE_RATE).toBe(fixture.constants.DEFAULT_TTS_SAMPLE_RATE);
    });

    test("MAX_TOOL_RESULT_CHARS unchanged", () => {
      expect(MAX_TOOL_RESULT_CHARS).toBe(fixture.constants.MAX_TOOL_RESULT_CHARS);
    });

    test("SessionErrorCodes is superset of fixture", () => {
      const currentCodes = new Set<string>(SessionErrorCodeSchema.options);
      for (const code of fixture.constants.SessionErrorCodes) {
        expect(currentCodes.has(code), `SessionErrorCode "${code}" was removed`).toBe(true);
      }
    });
  });
});
