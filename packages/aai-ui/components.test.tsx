// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { signal } from "@preact/signals";
import { render, screen } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import { App } from "./_components/app.tsx";
import { ChatView } from "./_components/chat-view.tsx";
import { ErrorBanner } from "./_components/error-banner.tsx";
import { MessageBubble } from "./_components/message-bubble.tsx";
import { StateIndicator } from "./_components/state-indicator.tsx";
import { Transcript } from "./_components/transcript.tsx";
import { createMockSignals } from "./_test-utils.ts";
import { SessionProvider, type SessionSignals } from "./signals.ts";
import type { AgentState, ChatMessage } from "./types.ts";

function renderWithProvider(vnode: preact.ComponentChildren, signals: SessionSignals) {
  return render(<SessionProvider value={signals}>{vnode}</SessionProvider>);
}

describe("StateIndicator", () => {
  test("renders the state label", () => {
    render(<StateIndicator state={signal<AgentState>("listening")} />);
    expect(screen.getByText("listening")).toBeDefined();
  });
});

describe("ErrorBanner", () => {
  test("renders error message", () => {
    render(
      <ErrorBanner
        error={signal({
          code: "connection" as const,
          message: "Connection lost",
        })}
      />,
    );
    expect(screen.getByText("Connection lost")).toBeDefined();
  });

  test("renders nothing when null", () => {
    const { container } = render(<ErrorBanner error={signal(null)} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("MessageBubble", () => {
  test("renders message text", () => {
    const msg: ChatMessage = { role: "user", content: "Hello there" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("Hello there")).toBeDefined();
  });

  test("renders assistant message text", () => {
    const msg: ChatMessage = { role: "assistant", content: "Simple reply" };
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("Simple reply")).toBeDefined();
  });
});

describe("Transcript", () => {
  test("renders transcript text", () => {
    render(<Transcript userUtterance={signal<string | null>("hello wor")} />);
    expect(screen.getByText("hello wor")).toBeDefined();
  });

  test("renders nothing when null", () => {
    const { container } = render(<Transcript userUtterance={signal<string | null>(null)} />);
    expect(container.innerHTML).toBe("");
  });

  test("renders thinking indicator when empty string (speech detected)", () => {
    const { container } = render(<Transcript userUtterance={signal<string | null>("")} />);
    expect(container.innerHTML !== "").toBe(true);
  });
});

describe("App", () => {
  test("shows start button when not started", () => {
    const signals = createMockSignals({ started: false });
    renderWithProvider(<App />, signals);
    expect(screen.getByText("Start")).toBeDefined();
  });

  test("shows ChatView when started", () => {
    const signals = createMockSignals({
      started: true,
      state: "listening",
      running: true,
    });
    renderWithProvider(<App />, signals);
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
  });

  test("transitions from start screen to chat", () => {
    const signals = createMockSignals({ started: false });
    const { rerender } = render(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("Start")).toBeDefined();

    signals.started.value = true;
    signals.session.state.value = "listening";
    rerender(
      <SessionProvider value={signals}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.queryByText("Start")).toBeNull();
  });
});

describe("ChatView", () => {
  test("renders state and messages", () => {
    const signals = createMockSignals({
      started: true,
      state: "thinking",
      running: true,
      messages: [
        { role: "user", content: "What is AI?" },
        { role: "assistant", content: "AI stands for..." },
      ],
    });
    renderWithProvider(<ChatView />, signals);

    expect(screen.getByText("thinking")).toBeDefined();
    expect(screen.getByText("What is AI?")).toBeDefined();
    expect(screen.getByText("AI stands for...")).toBeDefined();
  });

  test("renders transcript and error", () => {
    const signals = createMockSignals({
      started: true,
      state: "error",
      running: false,
      userUtterance: "hello wor",
      error: { code: "connection", message: "Connection failed" },
    });
    renderWithProvider(<ChatView />, signals);

    expect(screen.getByText("hello wor")).toBeDefined();
    expect(screen.getByText("Connection failed")).toBeDefined();
  });

  test("shows Stop when running, Resume when not", () => {
    const signals = createMockSignals({
      started: true,
      state: "listening",
      running: true,
    });
    const { rerender } = render(
      <SessionProvider value={signals}>
        <ChatView />
      </SessionProvider>,
    );

    expect(screen.getByText("Stop")).toBeDefined();
    expect(screen.getByText("New Conversation")).toBeDefined();

    signals.running.value = false;
    rerender(
      <SessionProvider value={signals}>
        <ChatView />
      </SessionProvider>,
    );
    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("renders messages in order", () => {
    const signals = createMockSignals({
      started: true,
      state: "listening",
      running: true,
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Second" },
        { role: "user", content: "Third" },
      ],
    });
    renderWithProvider(<ChatView />, signals);

    const first = screen.getByText("First");
    const second = screen.getByText("Second");
    const third = screen.getByText("Third");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
