// Copyright 2025 the AAI authors. MIT license.
/**
 * Custom Vitest matchers for AAI domain types.
 *
 * Registered via `expect.extend()` — add this file to the vitest `setupFiles`
 * for the `aai` project so matchers are available in every test.
 */

import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import { ClientEventSchema } from "./protocol.ts";

type MatcherResult = { pass: boolean; message: () => string };

// ─── Matcher implementations ────────────────────────────────────────────────

function toBeValidClientEvent(received: unknown): MatcherResult {
  const result = ClientEventSchema.safeParse(received);
  return {
    pass: result.success,
    message: () =>
      result.success
        ? "expected value NOT to be a valid ClientEvent, but it parsed successfully"
        : `expected value to be a valid ClientEvent\n\nZod errors:\n${result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
  };
}

function toContainEvent(
  received: unknown,
  type: string,
  fields?: Record<string, unknown>,
): MatcherResult {
  if (!Array.isArray(received)) {
    return {
      pass: false,
      message: () => `expected an array of events, but received ${typeof received}`,
    };
  }

  const match = received.some((event: Record<string, unknown>) => {
    if (event?.type !== type) return false;
    if (!fields) return true;
    return Object.entries(fields).every(([key, value]) => isDeepStrictEqual(event[key], value));
  });

  return {
    pass: match,
    message: () =>
      match
        ? `expected array NOT to contain event of type "${type}"${fields ? ` with fields ${JSON.stringify(fields)}` : ""}`
        : `expected array to contain event of type "${type}"${fields ? ` with fields ${JSON.stringify(fields)}` : ""}\n\nReceived event types: [${received.map((e: Record<string, unknown>) => `"${e?.type}"`).join(", ")}]`,
  };
}

// ─── Register matchers ──────────────────────────────────────────────────────

expect.extend({
  toBeValidClientEvent,
  toContainEvent,
});

// ─── Type augmentation ──────────────────────────────────────────────────────

declare module "vitest" {
  interface Assertion<T> {
    toBeValidClientEvent(): void;
    toContainEvent(type: string, fields?: Record<string, unknown>): void;
  }
  interface AsymmetricMatchersContaining {
    toBeValidClientEvent(): void;
    toContainEvent(type: string, fields?: Record<string, unknown>): void;
  }
}
