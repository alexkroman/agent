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
import type { ZodTypeAny } from "zod";
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

const FIXTURE_DIR = join(import.meta.dirname, "compat-fixtures");

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

// Wire-format fixtures (e.g. wire-v1.json) use a different shape and live in
// wire.test.ts; filter them out by checking for the schema-compat structure.
const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => {
    const parsed = loadFixture(f) as unknown as Record<string, unknown>;
    return "ServerMessage" in parsed && "ClientMessage" in parsed;
  })
  .sort();

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

// A minimal-discriminant parse fails either with "Invalid discriminator" (variant
// removed) or with missing-field errors (variant exists). The Zod issue code for
// discriminated-union mismatches varies across versions, so match on message text.
function schemaAcceptsDiscriminant(schema: ZodTypeAny, value: Record<string, unknown>): boolean {
  const result = schema.safeParse(value);
  if (result.success) return true;
  return !result.error.issues.some((i) => i.message.includes("Invalid discriminator"));
}

type CompatGroup = {
  label: string;
  schema: ZodTypeAny;
  messages: Record<string, unknown>[];
  discriminant: "type" | "op";
};

describe.each(fixtureFiles)("compat fixture: %s", (filename) => {
  const fixture = loadFixture(filename);

  const groups: CompatGroup[] = [
    {
      label: "ServerMessage",
      schema: ServerMessageSchema,
      messages: fixture.ServerMessage,
      discriminant: "type",
    },
    {
      label: "ClientMessage",
      schema: ClientMessageSchema,
      messages: fixture.ClientMessage,
      discriminant: "type",
    },
    {
      label: "KvRequest",
      schema: KvRequestSchema,
      messages: fixture.KvRequest,
      discriminant: "op",
    },
  ];

  for (const { label, schema, messages, discriminant } of groups) {
    describe(`${label} backward compat`, () => {
      test.each(
        messages.map((m, i) => [`${m[discriminant] as string}#${i}`, m]),
      )("%s parses against current schema", (_label, msg) => {
        const result = schema.safeParse(msg);
        if (!result.success) {
          throw new Error(compatError(filename, label, msg, result.error.message));
        }
      });
    });
  }

  describe("variant coverage", () => {
    for (const { label, schema, messages, discriminant } of groups) {
      const noun = discriminant === "type" ? "variant" : "op";
      test(`no ${label} ${noun}s removed`, () => {
        const seen = new Set(messages.map((m) => m[discriminant] as string));
        for (const value of seen) {
          expect(
            schemaAcceptsDiscriminant(schema, { [discriminant]: value }),
            `${label} ${noun} "${value}" was removed`,
          ).toBe(true);
        }
      });
    }
  });

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
