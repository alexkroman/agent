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

type EventLike = { type?: unknown; [key: string]: unknown };

function fieldsSuffix(fields?: Record<string, unknown>): string {
  return fields ? ` with fields ${JSON.stringify(fields)}` : "";
}

function toBeValidClientEvent(received: unknown): MatcherResult {
  const result = ClientEventSchema.safeParse(received);
  if (result.success) {
    return {
      pass: true,
      message: () => "expected value NOT to be a valid ClientEvent, but it parsed successfully",
    };
  }
  const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  return {
    pass: false,
    message: () => `expected value to be a valid ClientEvent\n\nZod errors:\n${issues}`,
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

  const events = received as EventLike[];
  const match = events.some((event) => {
    if (event?.type !== type) return false;
    if (!fields) return true;
    return Object.entries(fields).every(([key, value]) => isDeepStrictEqual(event[key], value));
  });

  if (match) {
    return {
      pass: true,
      message: () => `expected array NOT to contain event of type "${type}"${fieldsSuffix(fields)}`,
    };
  }
  const receivedTypes = events.map((e) => `"${e?.type}"`).join(", ");
  return {
    pass: false,
    message: () =>
      `expected array to contain event of type "${type}"${fieldsSuffix(fields)}\n\nReceived event types: [${receivedTypes}]`,
  };
}

expect.extend({
  toBeValidClientEvent,
  toContainEvent,
});

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
