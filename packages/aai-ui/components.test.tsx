// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render, screen } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import { createMockSession } from "./_test-utils.ts";
import { App } from "./components/app.tsx";
import { ChatView } from "./components/chat-view.tsx";
import { SessionProvider } from "./context.ts";
import type { VoiceSession } from "./session.ts";

function renderWithProvider(vnode: preact.ComponentChildren, session: VoiceSession) {
  return render(<SessionProvider value={session}>{vnode}</SessionProvider>);
}

describe("App", () => {
  test("shows start button when not started", () => {
    const signals = createMockSession({ started: false });
    renderWithProvider(<App />, signals);
    expect(screen.getByText("Start")).toBeDefined();
  });

  test("shows ChatView when started", () => {
    const signals = createMockSession({
      started: true,
      state: "listening",
      running: true,
    });
    renderWithProvider(<App />, signals);
    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
  });

  test("transitions from start screen to chat", () => {
    const session = createMockSession({ started: false });
    const { rerender } = render(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );
    expect(screen.getByText("Start")).toBeDefined();

    session.started.value = true;
    session.state.value = "listening";
    rerender(
      <SessionProvider value={session}>
        <App />
      </SessionProvider>,
    );

    expect(screen.getByText("listening")).toBeDefined();
    expect(screen.queryByText("Start")).toBeNull();
  });
});

describe("ChatView", () => {
  test("renders state and messages", () => {
    const signals = createMockSession({
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
    const signals = createMockSession({
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
    const signals = createMockSession({
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
    const signals = createMockSession({
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

  test("renders error banner when error is set", () => {
    const signals = createMockSession({
      started: true,
      state: "error",
      running: false,
      error: { code: "connection", message: "Connection lost" },
    });
    renderWithProvider(<ChatView />, signals);
    expect(screen.getByText("Connection lost")).toBeDefined();
  });

  test("renders nothing for error when null", () => {
    const signals = createMockSession({
      started: true,
      state: "listening",
      running: true,
    });
    const { container } = renderWithProvider(<ChatView />, signals);
    // No error banner should be present
    expect(container.querySelector(".text-aai-error")).toBeNull();
  });

  test("renders state indicator dot and label", () => {
    const signals = createMockSession({
      started: true,
      state: "listening",
      running: true,
    });
    renderWithProvider(<ChatView />, signals);
    expect(screen.getByText("listening")).toBeDefined();
  });
});
