// Copyright 2025 the AAI authors. MIT license.

import { signal } from "@preact/signals";
import { render } from "preact";
import { describe, expect, test } from "vitest";
import { App } from "./_components/app.tsx";
import { ChatView } from "./_components/chat_view.tsx";
import { ErrorBanner } from "./_components/error_banner.tsx";
import { MessageBubble } from "./_components/message_bubble.tsx";
import { StateIndicator } from "./_components/state_indicator.tsx";
import { Transcript } from "./_components/transcript.tsx";
import { createMockSignals, withDOM } from "./_test_utils.ts";
import { SessionProvider, type SessionSignals } from "./signals.ts";
import type { AgentState, Message } from "./types.ts";

function renderWithProvider(
  container: Element,
  vnode: preact.ComponentChildren,
  signals: SessionSignals,
) {
  render(<SessionProvider value={signals}>{vnode}</SessionProvider>, container);
}

describe("StateIndicator", () => {
  test(
    "renders the state label",
    withDOM((container) => {
      render(<StateIndicator state={signal<AgentState>("listening")} />, container);
      expect(container.textContent ?? "").toContain("listening");
    }),
  );
});

describe("ErrorBanner", () => {
  test(
    "renders error message",
    withDOM((container) => {
      render(
        <ErrorBanner
          error={signal({
            code: "connection" as const,
            message: "Connection lost",
          })}
        />,
        container,
      );
      expect(container.textContent ?? "").toContain("Connection lost");
    }),
  );

  test(
    "renders nothing when null",
    withDOM((container) => {
      render(<ErrorBanner error={signal(null)} />, container);
      expect(container.innerHTML).toBe("");
    }),
  );
});

describe("MessageBubble", () => {
  test(
    "renders message text",
    withDOM((container) => {
      const msg: Message = { role: "user", text: "Hello there" };
      render(<MessageBubble message={msg} />, container);
      expect(container.textContent ?? "").toContain("Hello there");
    }),
  );

  test(
    "renders assistant message text",
    withDOM((container) => {
      const msg: Message = { role: "assistant", text: "Simple reply" };
      render(<MessageBubble message={msg} />, container);
      expect(container.textContent).toBe("Simple reply");
    }),
  );
});

describe("Transcript", () => {
  test(
    "renders transcript text",
    withDOM((container) => {
      render(<Transcript userUtterance={signal<string | null>("hello wor")} />, container);
      expect(container.textContent ?? "").toContain("hello wor");
    }),
  );

  test(
    "renders nothing when null",
    withDOM((container) => {
      render(<Transcript userUtterance={signal<string | null>(null)} />, container);
      expect(container.innerHTML).toBe("");
    }),
  );

  test(
    "renders thinking indicator when empty string (speech detected)",
    withDOM((container) => {
      render(<Transcript userUtterance={signal<string | null>("")} />, container);
      // Should render something (the ThinkingIndicator), not be empty
      expect(container.innerHTML !== "").toBe(true);
    }),
  );
});

describe("App", () => {
  test(
    "shows start button when not started",
    withDOM((container) => {
      const signals = createMockSignals({ started: false });
      renderWithProvider(container, <App />, signals);
      expect(container.querySelector("button")?.textContent).toBe("Start");
    }),
  );

  test(
    "shows ChatView when started",
    withDOM((container) => {
      const signals = createMockSignals({
        started: true,
        state: "listening",
        running: true,
      });
      renderWithProvider(container, <App />, signals);
      expect(container.textContent ?? "").toContain("listening");
      expect(container.textContent ?? "").toContain("Stop");
    }),
  );

  test(
    "transitions from start screen to chat",
    withDOM((container) => {
      const signals = createMockSignals({ started: false });
      renderWithProvider(container, <App />, signals);
      expect(container.querySelector("button")?.textContent).toBe("Start");

      signals.started.value = true;
      signals.session.state.value = "listening";
      renderWithProvider(container, <App />, signals);

      expect(container.textContent ?? "").toContain("listening");
      expect(!container.textContent?.includes("Start")).toBe(true);
    }),
  );
});

describe("ChatView", () => {
  test(
    "renders state and messages",
    withDOM((container) => {
      const signals = createMockSignals({
        started: true,
        state: "thinking",
        running: true,
        messages: [
          { role: "user", text: "What is AI?" },
          { role: "assistant", text: "AI stands for..." },
        ],
      });
      renderWithProvider(container, <ChatView />, signals);

      expect(container.textContent ?? "").toContain("thinking");
      expect(container.textContent ?? "").toContain("What is AI?");
      expect(container.textContent ?? "").toContain("AI stands for...");
    }),
  );

  test(
    "renders transcript and error",
    withDOM((container) => {
      const signals = createMockSignals({
        started: true,
        state: "error",
        running: false,
        userUtterance: "hello wor",
        error: { code: "connection", message: "Connection failed" },
      });
      renderWithProvider(container, <ChatView />, signals);

      expect(container.textContent ?? "").toContain("hello wor");
      expect(container.textContent ?? "").toContain("Connection failed");
    }),
  );

  test(
    "shows Stop when running, Resume when not",
    withDOM((container) => {
      const signals = createMockSignals({
        started: true,
        state: "listening",
        running: true,
      });
      renderWithProvider(container, <ChatView />, signals);

      const text = () => container.textContent ?? "";

      expect(text()).toContain("Stop");
      expect(text()).toContain("New Conversation");

      signals.running.value = false;
      renderWithProvider(container, <ChatView />, signals);
      expect(text()).toContain("Resume");
    }),
  );

  test(
    "renders messages in order",
    withDOM((container) => {
      const signals = createMockSignals({
        started: true,
        state: "listening",
        running: true,
        messages: [
          { role: "user", text: "First" },
          { role: "assistant", text: "Second" },
          { role: "user", text: "Third" },
        ],
      });
      renderWithProvider(container, <ChatView />, signals);

      const text = container.textContent ?? "";
      expect(text.indexOf("First") < text.indexOf("Second")).toBe(true);
      expect(text.indexOf("Second") < text.indexOf("Third")).toBe(true);
    }),
  );
});
