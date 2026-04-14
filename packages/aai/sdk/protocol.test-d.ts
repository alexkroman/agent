// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the wire protocol types in `@alexkroman1/aai/protocol`.
 *
 * These are checked by tsc (via vitest typecheck) but never executed at runtime.
 */

import type { ClientEvent, ServerMessage } from "@alexkroman1/aai/protocol";
import { lenientParse } from "@alexkroman1/aai/protocol";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";

test("ClientEvent narrows on type discriminant: user_transcript", () => {
  // Extract the user_transcript variant from the union
  type UserTranscript = Extract<ClientEvent, { type: "user_transcript" }>;
  expectTypeOf<UserTranscript>().toHaveProperty("text");
  expectTypeOf<UserTranscript["text"]>().toBeString();
  expectTypeOf<UserTranscript["type"]>().toEqualTypeOf<"user_transcript">();
});

test("ClientEvent narrows on type discriminant: tool_call", () => {
  type ToolCall = Extract<ClientEvent, { type: "tool_call" }>;
  expectTypeOf<ToolCall>().toHaveProperty("toolCallId");
  expectTypeOf<ToolCall>().toHaveProperty("toolName");
  expectTypeOf<ToolCall>().toHaveProperty("args");
  expectTypeOf<ToolCall["toolCallId"]>().toBeString();
  expectTypeOf<ToolCall["toolName"]>().toBeString();
  expectTypeOf<ToolCall["args"]>().toEqualTypeOf<Record<string, unknown>>();
});

test("ClientEvent narrows on type discriminant: error", () => {
  type ErrorEvent = Extract<ClientEvent, { type: "error" }>;
  expectTypeOf<ErrorEvent>().toHaveProperty("code");
  expectTypeOf<ErrorEvent>().toHaveProperty("message");
  expectTypeOf<ErrorEvent["message"]>().toBeString();
  expectTypeOf<ErrorEvent["type"]>().toEqualTypeOf<"error">();
});

test("ServerMessage is a discriminated union on type", () => {
  // ServerMessage should have a `type` property on all variants
  expectTypeOf<ServerMessage>().toHaveProperty("type");
  expectTypeOf<ServerMessage["type"]>().toBeString();

  // Config variant should have audio-related fields
  type ConfigMsg = Extract<ServerMessage, { type: "config" }>;
  expectTypeOf<ConfigMsg>().toHaveProperty("audioFormat");
  expectTypeOf<ConfigMsg>().toHaveProperty("sampleRate");
  expectTypeOf<ConfigMsg>().toHaveProperty("ttsSampleRate");
});

test("lenientParse returns ok:true with data or ok:false with malformed+error", () => {
  const schema = z.object({ type: z.literal("test"), value: z.number() });
  type Parsed = z.infer<typeof schema>;

  const result = lenientParse(schema, {});

  // Full return type is a discriminated union on `ok`
  expectTypeOf(result).toEqualTypeOf<
    { ok: true; data: Parsed } | { ok: false; malformed: boolean; error: string }
  >();

  // Success branch shape
  type OkBranch = Extract<typeof result, { ok: true }>;
  expectTypeOf<OkBranch["data"]>().toEqualTypeOf<Parsed>();

  // Failure branch shape
  type ErrBranch = Extract<typeof result, { ok: false }>;
  expectTypeOf<ErrBranch["malformed"]>().toBeBoolean();
  expectTypeOf<ErrBranch["error"]>().toBeString();
});
