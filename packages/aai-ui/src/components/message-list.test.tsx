// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * `MessageList` — the stock bubbles filled into `ConversationView`'s slots.
 *
 * Moved from `integration.test.tsx`. The rules the rows obey (interleave,
 * streaming row, thinking suppression) are `useConversation`'s and the row
 * order is `ConversationView`'s; what is asserted here is that this list
 * renders them with the stock bubbles, end to end from a session snapshot.
 */
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { BrowserSession } from "../session/index.ts";
import { MessageList } from "./message-list.tsx";

function renderWithProvider(children: ReactNode, session: BrowserSession) {
  return render(
    <ThemeProvider>
      <SessionProvider value={session}>{children}</SessionProvider>
    </ThemeProvider>,
  );
}

describe("MessageList: messages + tool calls interleaved", () => {
  test("renders tool calls after their associated message", () => {
    const core = createMockSessionCore({
      started: true,
      state: "listening",
      messages: [
        { id: 1, role: "user", content: "What's the weather?" },
        { id: 2, role: "assistant", content: "It's sunny and 72\u00B0F." },
      ],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: { query: "weather" },
          status: "done",
          result: '{"temp": 72}',
          seq: 1,
          afterMessageId: 1,
        },
      ],
    });

    renderWithProvider(<MessageList />, core);

    const userMsg = screen.getByText("What's the weather?");
    const toolCall = screen.getByText("web_search");
    const assistantMsg = screen.getByText("It's sunny and 72\u00B0F.");

    // Tool call appears after user message and before assistant message
    expect(
      userMsg.compareDocumentPosition(toolCall) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolCall.compareDocumentPosition(assistantMsg) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("renders tool calls whose anchor message slid out of the window first", () => {
    const core = createMockSessionCore({
      started: true,
      state: "listening",
      // Window slid: messages with ids 1-4 were dropped; the tool call is
      // anchored to a message (id 2) that no longer exists.
      messages: [
        { id: 5, role: "user", content: "newer question" },
        { id: 6, role: "assistant", content: "newer answer" },
      ],
      toolCalls: [
        {
          callId: "tc-old",
          name: "web_search",
          args: { query: "old" },
          status: "done",
          result: "{}",
          seq: 1,
          afterMessageId: 2,
        },
      ],
    });

    renderWithProvider(<MessageList />, core);

    const toolCall = screen.getByText("web_search");
    const firstMsg = screen.getByText("newer question");
    // The orphaned tool call renders before all retained messages.
    expect(
      toolCall.compareDocumentPosition(firstMsg) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("message rows keep stable keys when the window slides (no remount churn)", () => {
    const core = createMockSessionCore({
      started: true,
      state: "listening",
      messages: [
        { id: 1, role: "user", content: "first" },
        { id: 2, role: "assistant", content: "second" },
      ],
    });

    const { container } = renderWithProvider(<MessageList />, core);
    const secondBubbleBefore = screen.getByText("second");

    // Simulate the capped window sliding: drop id 1, append id 3. The
    // surviving row (id 2) must be the same DOM element — stable ids as keys
    // let the reconciler and memo() reuse it.
    act(() =>
      core.update({
        messages: [
          { id: 2, role: "assistant", content: "second" },
          { id: 3, role: "user", content: "third" },
        ],
      }),
    );
    expect(screen.getByText("second")).toBe(secondBubbleBefore);
    expect(container.textContent).not.toContain("first");
    expect(screen.getByText("third")).toBeDefined();
  });

  test("shows thinking indicator when state is thinking and no pending tool", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ id: 1, role: "user", content: "Tell me a joke" }],
    });

    renderWithProvider(<MessageList />, core);
    // By ROLE, not by counting `.rounded-full` elements: that count broke when
    // the three dots became anything else (correct behaviour, red test) and
    // when any sibling row gained a round badge (wrong behaviour, green test).
    // The class-assertion argument this package makes elsewhere is about
    // cascade and layout, which does not apply to element presence.
    expect(screen.getByRole("status", { name: "Thinking" })).toBeDefined();
  });

  test("hides thinking indicator when a tool call is pending", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ id: 1, role: "user", content: "Search for AI news" }],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: {},
          status: "pending",
          seq: 1,
          afterMessageId: 1,
        },
      ],
    });

    renderWithProvider(<MessageList />, core);
    // The pending tool row IS the progress signal, so the dots must not double
    // it. Asserted by role for the reason the sibling above gives.
    expect(screen.queryByRole("status", { name: "Thinking" })).toBeNull();
  });

  test("shows pending tool call with shimmer animation", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ id: 1, role: "user", content: "Search" }],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: { query: "test" },
          status: "pending",
          seq: 1,
          afterMessageId: 1,
        },
      ],
    });

    const { container } = renderWithProvider(<MessageList />, core);
    expect(container.innerHTML).toContain("tool-shimmer");
    expect(screen.getByText("web_search")).toBeDefined();
  });

  test("shows streaming agent utterance as bubble", () => {
    const core = createMockSessionCore({
      started: true,
      state: "speaking",
      agentTranscript: "I'm thinking about...",
    });

    renderWithProvider(<MessageList />, core);
    expect(screen.getByText("I'm thinking about...")).toBeDefined();
  });

  test("shows user transcript while speaking", () => {
    const core = createMockSessionCore({
      started: true,
      state: "listening",
      userTranscript: "hello wor",
    });

    renderWithProvider(<MessageList />, core);
    expect(screen.getByText("hello wor")).toBeDefined();
  });
});

describe("MessageList: stick-to-bottom scroll container", () => {
  // Auto-scroll itself (pin at the bottom, release on scroll-up, follow
  // content that grows without a snapshot update) is use-stick-to-bottom's
  // behavior, driven by real layout + a ResizeObserver — neither of which
  // jsdom provides — so this asserts the DOM contract the library needs:
  // wrapper (role="log") -> scroll element -> content element.
  test("renders the wrapper/scroll/content structure with the list styling", () => {
    const core = createMockSessionCore({ started: true, state: "listening" });
    renderWithProvider(<MessageList className="custom-class" />, core);

    const log = screen.getByRole("log");
    expect(log.className).toContain("flex-1");
    expect(log.className).toContain("custom-class");

    const scroller = log.firstElementChild as HTMLElement;
    expect(scroller.className).toContain("overflow-y-auto");

    const content = scroller.firstElementChild as HTMLElement;
    expect(content.className).toContain("flex-col");

    // New content renders inside the observed content element.
    act(() => core.update({ messages: [{ id: 1, role: "user", content: "one" }] }));
    expect(content.textContent).toContain("one");
  });
});
