// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API surface of @alexkroman1/aai-ui.
 *
 * These are checked by tsc (via vitest typecheck) but never executed.
 * A failure here means a public type contract has regressed.
 */

import type { Signal } from "@preact/signals";
import { describe, expectTypeOf, it } from "vitest";
import {
  type AgentState,
  type ChatMessage,
  createVoiceSession,
  type SessionError,
  type SessionErrorCode,
  type ToolCallInfo,
  type VoiceSession,
  type VoiceSessionOptions,
} from "./session.ts";

// ─── createVoiceSession ───────────────────────────────────────────────────

describe("createVoiceSession", () => {
  it("accepts VoiceSessionOptions and returns VoiceSession", () => {
    const session = createVoiceSession({ platformUrl: "ws://localhost:3000" });
    expectTypeOf(session).toMatchTypeOf<VoiceSession>();
  });

  it("requires platformUrl", () => {
    // @ts-expect-error — platformUrl is required
    createVoiceSession({});
  });

  it("accepts VoiceSessionOptions shape", () => {
    expectTypeOf<VoiceSessionOptions>().toHaveProperty("platformUrl");
    expectTypeOf<VoiceSessionOptions["platformUrl"]>().toEqualTypeOf<string>();
  });
});

// ─── VoiceSession shape ───────────────────────────────────────────────────

describe("VoiceSession", () => {
  it("has reactive state signals", () => {
    expectTypeOf<VoiceSession["state"]>().toEqualTypeOf<Signal<AgentState>>();
    expectTypeOf<VoiceSession["messages"]>().toEqualTypeOf<Signal<ChatMessage[]>>();
    expectTypeOf<VoiceSession["toolCalls"]>().toEqualTypeOf<Signal<ToolCallInfo[]>>();
    expectTypeOf<VoiceSession["error"]>().toEqualTypeOf<Signal<SessionError | null>>();
  });

  it("has lifecycle methods", () => {
    expectTypeOf<VoiceSession["connect"]>().toMatchTypeOf<
      (options?: { signal?: AbortSignal }) => void
    >();
    expectTypeOf<VoiceSession["disconnect"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["cancel"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["reset"]>().toEqualTypeOf<() => void>();
  });
});

// ─── Key types have expected shapes ───────────────────────────────────────

describe("exported types", () => {
  it("AgentState is a union of known states", () => {
    expectTypeOf<AgentState>().toEqualTypeOf<
      "disconnected" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error"
    >();
  });

  it("ChatMessage has expected shape", () => {
    expectTypeOf<ChatMessage>().toEqualTypeOf<{
      role: "user" | "assistant";
      content: string;
    }>();
  });

  it("ToolCallInfo has expected shape", () => {
    expectTypeOf<ToolCallInfo>().toEqualTypeOf<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: "pending" | "done";
      result?: string | undefined;
      afterMessageIndex: number;
    }>();
  });

  it("SessionError has expected shape", () => {
    expectTypeOf<SessionError>().toEqualTypeOf<{
      readonly code: SessionErrorCode;
      readonly message: string;
    }>();
  });
});
