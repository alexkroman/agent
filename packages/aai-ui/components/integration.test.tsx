// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * UI component integration tests.
 *
 * Test component interactions and state flows through the full component tree:
 * button clicks -> state changes -> re-renders, tool calls interleaved with
 * messages, thinking indicator visibility, and start screen transitions.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { SessionCore } from "../session-core.ts";
import { ChatView } from "./chat-view.tsx";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";
import { StartScreen } from "./start-screen.tsx";

function renderWithProvider(children: ReactNode, session: SessionCore) {
  return render(
    <ThemeProvider>
      <SessionProvider value={session}>{children}</SessionProvider>
    </ThemeProvider>,
  );
}

// --- Button click interactions ---

describe("Controls: click interactions", () => {
  test("clicking Stop calls toggle and switches to Resume", () => {
    const core = createMockSessionCore({ started: true, running: true });
    const calls: string[] = [];
    const origToggle = core.toggle.bind(core);
    core.toggle = () => {
      calls.push("toggle");
      origToggle();
    };

    renderWithProvider(<Controls />, core);
    const stopBtn = screen.getByText("Stop");
    fireEvent.click(stopBtn);

    expect(calls).toEqual(["toggle"]);
    expect(core.getSnapshot().running).toBe(false);
    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("clicking New Conversation calls reset", () => {
    const core = createMockSessionCore({ started: true, running: true });
    const calls: string[] = [];
    core.reset = () => calls.push("reset");

    renderWithProvider(<Controls />, core);
    fireEvent.click(screen.getByText("New Conversation"));
    expect(calls).toEqual(["reset"]);
  });
});

// --- StartScreen transitions ---

describe("StartScreen: start flow", () => {
  test("clicking Start button triggers start and shows children", () => {
    const core = createMockSessionCore({ started: false });

    renderWithProvider(
      <StartScreen>
        <div data-testid="chat">Chat content</div>
      </StartScreen>,
      core,
    );

    // Shows start button, not children
    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.queryByTestId("chat")).toBeNull();

    // Click start
    fireEvent.click(screen.getByText("Start"));

    // start() sets started=true, which notifies subscribers and triggers re-render
    expect(screen.queryByText("Start")).toBeNull();
    expect(screen.getByTestId("chat")).toBeDefined();
  });

  test("renders custom button text", () => {
    const core = createMockSessionCore({ started: false });
    renderWithProvider(
      <StartScreen buttonText="Begin Session">
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByText("Begin Session")).toBeDefined();
  });

  test("renders title and subtitle", () => {
    const core = createMockSessionCore({ started: false });
    renderWithProvider(
      <StartScreen title="Pizza Bot" subtitle="Order by voice">
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByText("Pizza Bot")).toBeDefined();
    expect(screen.getByText("Order by voice")).toBeDefined();
  });
});

// --- MessageList with tool calls ---

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

    const { container } = renderWithProvider(<MessageList />, core);
    // ThinkingIndicator renders 3 dots
    const dots = container.querySelectorAll(".rounded-full");
    expect(dots.length).toBe(3);
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

    const { container } = renderWithProvider(<MessageList />, core);
    // When a tool call is pending, thinking dots should not show
    const thinkingDots = container.querySelectorAll(".rounded-full");
    expect(thinkingDots.length).toBe(0);
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

// --- Full flow (replaces App tests) ---

describe("ChatView + StartScreen: full component tree integration", () => {
  test("start -> messages -> tool calls -> error -> recovery flow", () => {
    const core = createMockSessionCore({ started: false });

    render(
      <ThemeProvider>
        <SessionProvider value={core}>
          <StartScreen>
            <ChatView />
          </StartScreen>
        </SessionProvider>
      </ThemeProvider>,
    );

    // 1. Start screen
    expect(screen.getByText("Start")).toBeDefined();

    // 2. Click start -> chat view
    fireEvent.click(screen.getByText("Start"));

    // The start() call sets started=true and running=true
    // We also need to update state to "listening"
    act(() => core.update({ state: "listening" }));
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();

    // 3. User message
    act(() =>
      core.update({
        messages: [{ id: 1, role: "user", content: "What time is it?" }],
        state: "thinking",
      }),
    );
    expect(screen.getByText("What time is it?")).toBeDefined();
    expect(screen.getByText("thinking")).toBeDefined();

    // 4. Assistant responds
    act(() =>
      core.update({
        messages: [
          { id: 1, role: "user", content: "What time is it?" },
          { id: 2, role: "assistant", content: "It's 3pm." },
        ],
        state: "listening",
      }),
    );
    expect(screen.getByText("It's 3pm.")).toBeDefined();

    // 5. Error occurs
    act(() =>
      core.update({
        state: "disconnected",
        error: { code: "connection", message: "Lost connection" },
        running: false,
      }),
    );
    expect(screen.getByText("Lost connection")).toBeDefined();
    expect(screen.getByText("Resume")).toBeDefined();
  });
});
