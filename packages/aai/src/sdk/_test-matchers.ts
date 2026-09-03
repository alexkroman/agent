// Copyright 2025 the AAI authors. MIT license.
/**
 * Custom Vitest matchers for AAI domain types.
 *
 * Registered via `expect.extend()` — add this file to the vitest `setupFiles`
 * for the `aai` project so matchers are available in every test.
 */

import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import { isRecord } from "./is-record.ts";
import { EVENT_ID_PREFIX, SessionEventSchema } from "./protocol.ts";

type MatcherResult = { pass: boolean; message: () => string };

type EventLike = { type?: unknown; [key: string]: unknown };

function fieldsSuffix(fields?: Record<string, unknown>): string {
  return fields ? ` with fields ${JSON.stringify(fields)}` : "";
}

/**
 * A spec asserts on an event BODY — the shape emitting code writes — so the
 * matcher supplies the envelope the wire schema requires. Hand-writing a `meta`
 * per assertion would be noise, and a fake id per assertion would invite reading
 * one as meaningful.
 */
function withStubMeta(received: unknown): unknown {
  if (!isRecord(received)) return received;
  if ("meta" in received) return received;
  return { ...received, meta: { id: `${EVENT_ID_PREFIX}TEST`, at: 0 } };
}

function toBeValidSessionEvent(received: unknown): MatcherResult {
  const result = SessionEventSchema.safeParse(withStubMeta(received));
  if (result.success) {
    return {
      pass: true,
      message: () => "expected value NOT to be a valid session event, but it parsed successfully",
    };
  }
  const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  return {
    pass: false,
    message: () => `expected value to be a valid session event\n\nZod errors:\n${issues}`,
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
  toBeValidSessionEvent,
  toContainEvent,
});

declare module "vitest" {
  interface Assertion<T> {
    toBeValidSessionEvent(): void;
    toContainEvent(type: string, fields?: Record<string, unknown>): void;
  }
  interface AsymmetricMatchersContaining {
    toBeValidSessionEvent(): void;
    toContainEvent(type: string, fields?: Record<string, unknown>): void;
  }
}
