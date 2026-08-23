// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useConversation` is the headless half of `<MessageList>`, and these are the
 * assertions that CANNOT be made through the list: that the interleave is
 * ordered data rather than ordered markup, that the thinking suppression rule
 * is a boolean a custom chrome can read, and that reading the conversation does
 * not buy a whole-snapshot subscription.
 *
 * The rendered half stays covered by `components/integration.test.tsx`, which
 * now exercises this hook transitively — the point of building the list on it.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import type { ChatMessage, ToolCallInfo } from "./types.ts";
import { type ConversationItem, useConversation } from "./use-conversation.ts";

function message(id: number, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content };
}

function toolCall(callId: string, afterMessageId: number, seq: number): ToolCallInfo {
  return { callId, name: "lookup", args: {}, status: "done", seq, afterMessageId };
}

function mount(core: ReturnType<typeof createMockSessionCore>) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
  return renderHook(() => useConversation(), { wrapper });
}

/** The union collapsed to something a failure message can print. */
function shape(items: readonly ConversationItem[]): string[] {
  return items.map((item) =>
    item.kind === "message" ? `m:${item.message.id}` : `t:${item.toolCall.callId}`,
  );
}

describe("useConversation: the interleave", () => {
  test("places each tool call immediately after the message it followed", () => {
    const core = createMockSessionCore({
      messages: [message(1, "user", "hi"), message(2, "assistant", "one moment")],
      toolCalls: [toolCall("a", 1, 1), toolCall("b", 2, 2)],
    });
    const { result } = mount(core);
    expect(shape(result.current.items)).toEqual(["m:1", "t:a", "m:2", "t:b"]);
  });

  test("orphaned tool calls lead, because there is nothing left for them to follow", () => {
    // `afterMessageId` below the retained window: the anchor slid out under the
    // 200-message cap, or the call was made before any message existed.
    const core = createMockSessionCore({
      messages: [message(50, "user", "still here")],
      toolCalls: [toolCall("stale", 3, 1)],
    });
    const { result } = mount(core);
    expect(shape(result.current.items)).toEqual(["t:stale", "m:50"]);
  });

  test("tool calls past the last message still render, rather than being dropped", () => {
    const core = createMockSessionCore({
      messages: [message(1, "user", "hi")],
      toolCalls: [toolCall("trailing", 9, 1)],
    });
    const { result } = mount(core);
    expect(shape(result.current.items)).toEqual(["m:1", "t:trailing"]);
  });

  test("the list is referentially stable across an unrelated snapshot change", () => {
    // What lets a consumer map it inside a `useMemo` keyed on it.
    const core = createMockSessionCore({ messages: [message(1, "user", "hi")], toolCalls: [] });
    const { result } = mount(core);
    const first = result.current.items;
    act(() => core.update({ recording: true }));
    expect(result.current.items).toBe(first);
  });
});

describe("useConversation: the thinking rule", () => {
  test("on while thinking with no messages yet", () => {
    const { result } = mount(createMockSessionCore({ state: "thinking" }));
    expect(result.current.thinking).toBe(true);
  });

  test("off unless the state is thinking", () => {
    const { result } = mount(createMockSessionCore({ state: "listening" }));
    expect(result.current.thinking).toBe(false);
  });

  test("off while a tool call is pending — the tool row already says so", () => {
    const core = createMockSessionCore({
      state: "thinking",
      messages: [message(1, "user", "hi")],
      toolCalls: [{ ...toolCall("a", 1, 1), status: "pending" }],
    });
    expect(mount(core).result.current.thinking).toBe(false);
  });

  test("off once an agent message has landed with no tool call after it", () => {
    // The reply has begun arriving; a second indicator under it reads as a
    // second thing happening.
    const core = createMockSessionCore({
      state: "thinking",
      messages: [message(1, "user", "hi"), message(2, "assistant", "sure")],
      toolCalls: [],
    });
    expect(mount(core).result.current.thinking).toBe(false);
  });

  test("back on after a settled tool call following the agent's message", () => {
    const core = createMockSessionCore({
      state: "thinking",
      messages: [message(1, "user", "hi"), message(2, "assistant", "checking")],
      toolCalls: [toolCall("a", 2, 1)],
    });
    expect(mount(core).result.current.thinking).toBe(true);
  });
});

describe("useConversation: the live rows", () => {
  test("forwards the streaming utterance and drops it when the turn ends", () => {
    const core = createMockSessionCore({ agentTranscript: "half a sen" });
    const { result } = mount(core);
    expect(result.current.streaming).toBe("half a sen");
    act(() => core.update({ agentTranscript: null }));
    expect(result.current.streaming).toBeNull();
  });

  test("keeps the transcript's null-vs-empty distinction rather than collapsing it", () => {
    // The whole reason a custom chrome gets this wrong: `""` means speech
    // detected with no words yet, and reads as "not speaking" under one falsy
    // check — at exactly the moment the indicator is for.
    const core = createMockSessionCore({ userTranscript: null });
    const { result } = mount(core);
    expect(result.current.transcript.speaking).toBe(false);

    act(() => core.update({ userTranscript: "" }));
    expect(result.current.transcript.speaking).toBe(true);
    expect(result.current.transcript.partial).toBe("");
    expect(result.current.transcript.text).toBe("…");

    act(() => core.update({ userTranscript: "book me" }));
    expect(result.current.transcript.text).toBe("book me");
  });
});

describe("useConversation: the subscription", () => {
  test("does not re-render on a snapshot change the conversation cannot see", () => {
    // Half the value of the hook: the three hand-rolled chromes call whole-page
    // `useSession()`, which re-renders on EVERY snapshot change. `apiUrl`
    // landing is the cheapest proof — nothing in the conversation reads it.
    const core = createMockSessionCore({ messages: [message(1, "user", "hi")] });
    const renders = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(
      () => {
        renders();
        return useConversation();
      },
      { wrapper },
    );
    const before = renders.mock.calls.length;
    act(() => core.update({ apiUrl: "ws://elsewhere/websocket", recording: true }));
    expect(renders.mock.calls.length).toBe(before);
  });

  test("does re-render when a message arrives", () => {
    const core = createMockSessionCore({ messages: [] });
    const { result } = mount(core);
    expect(result.current.items).toHaveLength(0);
    act(() => core.update({ messages: [message(1, "assistant", "hello")] }));
    expect(shape(result.current.items)).toEqual(["m:1"]);
  });
});
