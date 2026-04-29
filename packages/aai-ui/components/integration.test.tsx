// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

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
    fireEvent.click(screen.getByText("Stop"));

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

describe("StartScreen: start flow", () => {
  test("clicking Start button triggers start and shows children", () => {
    const core = createMockSessionCore({ started: false });

    renderWithProvider(
      <StartScreen>
        <div data-testid="chat">Chat content</div>
      </StartScreen>,
      core,
    );

    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.queryByTestId("chat")).toBeNull();

    fireEvent.click(screen.getByText("Start"));

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

describe("MessageList: messages + tool calls interleaved", () => {
  test("renders tool calls after their associated message", () => {
    const core = createMockSessionCore({
      started: true,
      state: "listening",
      messages: [
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "It's sunny and 72°F." },
      ],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: { query: "weather" },
          status: "done",
          result: '{"temp": 72}',
          afterMessageIndex: 0,
        },
      ],
    });

    renderWithProvider(<MessageList />, core);

    const userMsg = screen.getByText("What's the weather?");
    const toolCall = screen.getByText("web_search");
    const assistantMsg = screen.getByText("It's sunny and 72°F.");

    expect(
      userMsg.compareDocumentPosition(toolCall) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolCall.compareDocumentPosition(assistantMsg) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("shows thinking indicator when state is thinking and no pending tool", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Tell me a joke" }],
    });

    const { container } = renderWithProvider(<MessageList />, core);
    const dots = container.querySelectorAll(".rounded-full");
    expect(dots.length).toBe(3);
  });

  test("hides thinking indicator when a tool call is pending", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Search for AI news" }],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: {},
          status: "pending",
          afterMessageIndex: 0,
        },
      ],
    });

    const { container } = renderWithProvider(<MessageList />, core);
    const thinkingDots = container.querySelectorAll(".rounded-full");
    expect(thinkingDots.length).toBe(0);
  });

  test("shows pending tool call with shimmer animation", () => {
    const core = createMockSessionCore({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Search" }],
      toolCalls: [
        {
          callId: "tc1",
          name: "web_search",
          args: { query: "test" },
          status: "pending",
          afterMessageIndex: 0,
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

describe("ChatView + StartScreen: full component tree integration", () => {
  test("start -> messages -> tool calls -> error -> recovery flow", () => {
    const core = createMockSessionCore({ started: false });

    renderWithProvider(
      <StartScreen>
        <ChatView />
      </StartScreen>,
      core,
    );

    expect(screen.getByText("Start")).toBeDefined();

    fireEvent.click(screen.getByText("Start"));

    act(() => core.update({ state: "listening" }));
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();

    act(() =>
      core.update({
        messages: [{ role: "user", content: "What time is it?" }],
        state: "thinking",
      }),
    );
    expect(screen.getByText("What time is it?")).toBeDefined();
    expect(screen.getByText("thinking")).toBeDefined();

    act(() =>
      core.update({
        messages: [
          { role: "user", content: "What time is it?" },
          { role: "assistant", content: "It's 3pm." },
        ],
        state: "listening",
      }),
    );
    expect(screen.getByText("It's 3pm.")).toBeDefined();

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
