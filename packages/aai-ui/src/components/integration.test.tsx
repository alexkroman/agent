// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * UI component integration tests.
 *
 * Test component interactions and state flows through the full component tree:
 * button clicks → signal changes → re-renders, tool calls interleaved with
 * messages, thinking indicator visibility, and start screen transitions.
 */
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import { createMockSignals } from "../lib/test-utils.ts";
import { SessionProvider, type SessionSignals } from "../signals.ts";
import { App } from "./app.tsx";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";
import { StartScreen } from "./start-screen.tsx";

function renderWithProvider(vnode: preact.ComponentChildren, signals: SessionSignals) {
  return render(<SessionProvider value={signals}>{vnode}</SessionProvider>);
}

// --- Button click interactions ---

describe("Controls: click interactions", () => {
  test("clicking Stop calls toggle and switches to Resume", () => {
    const signals = createMockSignals({ started: true, running: true });
    const origToggle = signals.toggle;
    const calls: string[] = [];
    signals.toggle = () => {
      calls.push("toggle");
      origToggle.call(signals);
    };

    const { rerender } = renderWithProvider(<Controls />, signals);
    const stopBtn = screen.getByText("Stop");
    fireEvent.click(stopBtn);

    expect(calls).toEqual(["toggle"]);
    expect(signals.running.value).toBe(false);

    rerender(
      <SessionProvider value={signals}>
        <Controls />
      </SessionProvider>,
    );
    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("clicking New Conversation calls reset", () => {
    const signals = createMockSignals({ started: true, running: true });
    const calls: string[] = [];
    signals.reset = () => calls.push("reset");

    renderWithProvider(<Controls />, signals);
    fireEvent.click(screen.getByText("New Conversation"));
    expect(calls).toEqual(["reset"]);
  });
});

// --- StartScreen transitions ---

describe("StartScreen: start flow", () => {
  test("clicking Start button triggers start and shows children", () => {
    const signals = createMockSignals({ started: false });

    const { rerender } = render(
      <SessionProvider value={signals}>
        <StartScreen>
          <div data-testid="chat">Chat content</div>
        </StartScreen>
      </SessionProvider>,
    );

    // Shows start button, not children
    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.queryByTestId("chat")).toBeNull();

    // Click start
    fireEvent.click(screen.getByText("Start"));

    // start() sets started=true
    rerender(
      <SessionProvider value={signals}>
        <StartScreen>
          <div data-testid="chat">Chat content</div>
        </StartScreen>
      </SessionProvider>,
    );

    expect(screen.queryByText("Start")).toBeNull();
    expect(screen.getByTestId("chat")).toBeDefined();
  });

  test("renders custom button text", () => {
    const signals = createMockSignals({ started: false });
    renderWithProvider(
      <StartScreen buttonText="Begin Session">
        <div />
      </StartScreen>,
      signals,
    );
    expect(screen.getByText("Begin Session")).toBeDefined();
  });

  test("renders title and subtitle", () => {
    const signals = createMockSignals({ started: false });
    renderWithProvider(
      <StartScreen title="Pizza Bot" subtitle="Order by voice">
        <div />
      </StartScreen>,
      signals,
    );
    expect(screen.getByText("Pizza Bot")).toBeDefined();
    expect(screen.getByText("Order by voice")).toBeDefined();
  });
});

// --- MessageList with tool calls ---

describe("MessageList: messages + tool calls interleaved", () => {
  test("renders tool calls after their associated message", () => {
    const signals = createMockSignals({
      started: true,
      state: "listening",
      messages: [
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "It's sunny and 72°F." },
      ],
    });
    signals.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "web_search",
        args: { query: "weather" },
        status: "done",
        result: '{"temp": 72}',

        afterMessageIndex: 0,
      },
    ];

    renderWithProvider(<MessageList />, signals);

    const userMsg = screen.getByText("What's the weather?");
    const toolCall = screen.getByText("Web Search");
    const assistantMsg = screen.getByText("It's sunny and 72°F.");

    // Tool call appears after user message and before assistant message
    expect(
      userMsg.compareDocumentPosition(toolCall) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      toolCall.compareDocumentPosition(assistantMsg) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("shows thinking indicator when state is thinking and no pending tool", () => {
    const signals = createMockSignals({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Tell me a joke" }],
    });

    const { container } = renderWithProvider(<MessageList />, signals);
    // ThinkingIndicator renders 3 dots
    const dots = container.querySelectorAll(".rounded-full");
    expect(dots.length).toBe(3);
  });

  test("hides thinking indicator when a tool call is pending", () => {
    const signals = createMockSignals({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Search for AI news" }],
    });
    signals.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "web_search",
        args: {},
        status: "pending",

        afterMessageIndex: 0,
      },
    ];

    const { container } = renderWithProvider(<MessageList />, signals);
    // When a tool call is pending, thinking dots should not show
    const thinkingDots = container.querySelectorAll(".rounded-full");
    expect(thinkingDots.length).toBe(0);
  });

  test("shows pending tool call with shimmer animation", () => {
    const signals = createMockSignals({
      started: true,
      state: "thinking",
      messages: [{ role: "user", content: "Search" }],
    });
    signals.session.toolCalls.value = [
      {
        toolCallId: "tc1",
        toolName: "web_search",
        args: { query: "test" },
        status: "pending",

        afterMessageIndex: 0,
      },
    ];

    const { container } = renderWithProvider(<MessageList />, signals);
    expect(container.innerHTML).toContain("tool-shimmer");
    expect(screen.getByText("Web Search")).toBeDefined();
  });

  test("shows streaming agent utterance as bubble", () => {
    const signals = createMockSignals({
      started: true,
      state: "speaking",
      messages: [],
    });
    signals.session.agentUtterance.value = "I'm thinking about...";

    renderWithProvider(<MessageList />, signals);
    expect(screen.getByText("I'm thinking about...")).toBeDefined();
  });

  test("shows user transcript while speaking", () => {
    const signals = createMockSignals({
      started: true,
      state: "listening",
      messages: [],
      userUtterance: "hello wor",
    });

    renderWithProvider(<MessageList />, signals);
    expect(screen.getByText("hello wor")).toBeDefined();
  });
});

// --- Full App flow ---

describe("App: full component tree integration", () => {
  test("start → messages → tool calls → error → recovery flow", () => {
    const signals = createMockSignals({ started: false });

    const { rerender } = render(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    // 1. Start screen
    expect(screen.getByText("Start")).toBeDefined();

    // 2. Click start → chat view
    signals.started.value = true;
    signals.session.state.value = "listening";
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();

    // 3. User message
    signals.session.messages.value = [{ role: "user", content: "What time is it?" }];
    signals.session.state.value = "thinking";
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("What time is it?")).toBeDefined();
    expect(screen.getByText("thinking")).toBeDefined();

    // 4. Assistant responds
    signals.session.messages.value = [
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It's 3pm." },
    ];
    signals.session.state.value = "listening";
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("It's 3pm.")).toBeDefined();

    // 5. Error occurs
    signals.session.state.value = "error";
    signals.session.error.value = { code: "connection", message: "Lost connection" };
    signals.running.value = false;
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("Lost connection")).toBeDefined();
    expect(screen.getByText("Resume")).toBeDefined();
  });
});
