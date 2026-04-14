// Copyright 2025 the AAI authors. MIT license.
/**
 * Custom Vitest matchers for AAI domain types.
 *
 * Registered via `expect.extend()` — add this file to the vitest `setupFiles`
 * for the `aai` project so matchers are available in every test.
 */

import { expect } from "vitest";
import { ClientEventSchema } from "./protocol.ts";

/** Return type for custom matcher functions. */
type MatcherResult = { pass: boolean; message: () => string };

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Recursively deep-equal two values (JSON-safe subset). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  }
  return false;
}

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
    return Object.entries(fields).every(([key, value]) => deepEqual(event[key], value));
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
