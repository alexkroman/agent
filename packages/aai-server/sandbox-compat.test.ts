// Copyright 2025 the AAI authors. MIT license.
/**
 * RPC compatibility tests for the server-isolate boundary.
 *
 * Pinned fixture messages are tested against the current Zod schemas.
 * A failure means deployed agent bundles would return responses the
 * host can no longer parse.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
  HookResponseSchema,
  IsolateConfigSchema,
  ToolCallResponseSchema,
  TurnConfigResultSchema,
} from "./rpc-schemas.ts";

// ── Load fixtures ─────────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dirname, "compat-fixtures");
const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

type Fixture = {
  version: number;
  IsolateConfig: Record<string, unknown>[];
  ToolCallResponse: Record<string, unknown>[];
  HookResponse: Record<string, unknown>[];
  TurnConfigResult: (Record<string, unknown> | null)[];
};

function loadFixture(filename: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, filename), "utf-8"));
}

function compatError(fixture: string, schema: string, msg: unknown, zodError: string): string {
  return [
    `RPC COMPATIBILITY BREAK (${fixture}, ${schema}):`,
    "",
    "A deployed agent returning this response would fail host-side parsing:",
    `  ${JSON.stringify(msg)}`,
    "",
    `Zod error: ${zodError}`,
    "",
    "To resolve:",
    "  1. If UNINTENTIONAL: revert the schema change.",
    "  2. If INTENTIONAL: create a new fixture version and document the breaking change.",
  ].join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.each(fixtureFiles)("compat fixture: %s", (filename) => {
  const fixture = loadFixture(filename);

  describe("IsolateConfig backward compat", () => {
    test.each(
      fixture.IsolateConfig.map((m, i) => [`${(m as { name: string }).name}#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = IsolateConfigSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "IsolateConfig", msg, result.error.message));
      }
    });
  });

  describe("ToolCallResponse backward compat", () => {
    test.each(
      fixture.ToolCallResponse.map((m, i) => [`#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = ToolCallResponseSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "ToolCallResponse", msg, result.error.message));
      }
    });
  });

  describe("HookResponse backward compat", () => {
    test.each(
      fixture.HookResponse.map((m, i) => [`#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = HookResponseSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "HookResponse", msg, result.error.message));
      }
    });
  });

  describe("TurnConfigResult backward compat", () => {
    test.each(
      fixture.TurnConfigResult.map((m, i) => [`#${i}`, m]),
    )("%s parses against current schema", (_label, msg) => {
      const result = TurnConfigResultSchema.safeParse(msg);
      if (!result.success) {
        throw new Error(compatError(filename, "TurnConfigResult", msg, result.error.message));
      }
    });
  });
});
