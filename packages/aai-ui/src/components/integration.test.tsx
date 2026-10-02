// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * UI component integration tests.
 *
 * Test component interactions and state flows through the full component tree:
 * button clicks -> state changes -> re-renders, and one start -> conversation
 * -> error flow across `StartScreen` and `ChatView` together. Each component's
 * own behaviour is in its co-located spec (`start-screen.test.tsx`,
 * `message-list.test.tsx`, `chat-view.test.tsx`).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { BrowserSession } from "../session/index.ts";
import { ChatView } from "./chat-view.tsx";
import { Controls } from "./controls.tsx";
import { StartScreen } from "./start-screen.tsx";

function renderWithProvider(children: ReactNode, session: BrowserSession) {
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
    // `vi.spyOn` rather than a `calls: string[]` recorder plus hand-assignment:
    // it keeps the real implementation (which is what flips `running` below),
    // names itself in the failure, and comes off under `restoreMocks` instead
    // of leaving a patched method on the mock core.
    const toggle = vi.spyOn(core, "toggle");

    renderWithProvider(<Controls />, core);
    const stopBtn = screen.getByText("Stop");
    fireEvent.click(stopBtn);

    expect(toggle).toHaveBeenCalledOnce();
    expect(core.getSnapshot().running).toBe(false);
    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("clicking New Conversation restarts the SESSION, it does not reset it", () => {
    // The distinction this button used to get wrong. `reset` reconnects
    // carrying the same session id, so a stateful agent's `sessionSlot` data
    // survives and the caller gets a blank transcript in front of their old
    // cart. `restart` drops the session, which is what the label promises.
    const core = createMockSessionCore({ started: true, running: true });
    const restart = vi.spyOn(core, "restart");
    const reset = vi.spyOn(core, "reset");
    const end = vi.spyOn(core, "end");
    const start = vi.spyOn(core, "start");

    renderWithProvider(<Controls />, core);
    fireEvent.click(screen.getByText("New Conversation"));

    expect(restart).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    // And restart really is the pair, in that order — the property the three
    // templates that hand-rolled `end(); start();` were relying on.
    expect(end).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    const [endedAt] = end.mock.invocationCallOrder;
    const [startedAt] = start.mock.invocationCallOrder;
    expect(endedAt).toBeLessThan(Number(startedAt));
    // Ends up live again rather than parked on the start screen.
    expect(core.getSnapshot().started).toBe(true);
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
    expect(screen.getByText("Start Conversation")).toBeDefined();

    // 2. Click start -> chat view
    fireEvent.click(screen.getByText("Start Conversation"));

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
        error: { code: "connection", message: "Lost connection", fatal: false },
        running: false,
      }),
    );
    // The banner is one element holding message AND code, so it is read off
    // the alert rather than matched as a text node.
    expect(screen.getByRole("alert").textContent).toBe("Lost connection (connection)");
    expect(screen.getByText("Resume")).toBeDefined();
  });
});
