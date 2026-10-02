// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * `StartScreen` — the card shown until a session is started, then its children.
 *
 * Moved from `integration.test.tsx`; the start -> conversation flow across the
 * whole tree stays there.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { BrowserSession } from "../session/index.ts";
import { StartScreen } from "./start-screen.tsx";

function renderWithProvider(children: ReactNode, session: BrowserSession) {
  return render(
    <ThemeProvider>
      <SessionProvider value={session}>{children}</SessionProvider>
    </ThemeProvider>,
  );
}

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
    expect(screen.getByText("Start Conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("chat")).toBeNull();

    // Click start
    fireEvent.click(screen.getByText("Start Conversation"));

    // start() sets started=true, which notifies subscribers and triggers re-render
    expect(screen.queryByText("Start Conversation")).toBeNull();
    expect(screen.getByTestId("chat")).toBeInTheDocument();
  });

  test("renders custom button text", () => {
    const core = createMockSessionCore({ started: false });
    renderWithProvider(
      <StartScreen buttonText="Begin Session">
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByText("Begin Session")).toBeInTheDocument();
  });

  test("renders title and subtitle", () => {
    const core = createMockSessionCore({ started: false });
    renderWithProvider(
      <StartScreen title="Pizza Bot" subtitle="Order by voice">
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByText("Pizza Bot")).toBeInTheDocument();
    expect(screen.getByText("Order by voice")).toBeInTheDocument();
  });
});

describe("StartScreen: the card", () => {
  test("labels itself a voice agent, and Start calls the session's own start", () => {
    const core = createMockSessionCore({ started: false });
    const start = vi.spyOn(core, "start");
    renderWithProvider(
      <StartScreen>
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByText("Voice Agent")).toBeInTheDocument();
    // The default mark stands in until a caller passes its own icon.
    expect(screen.getByRole("img", { name: "AssemblyAI" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start Conversation" }));
    expect(start).toHaveBeenCalledOnce();
  });

  test("a caller's icon replaces the default mark", () => {
    const core = createMockSessionCore({ started: false });
    renderWithProvider(
      <StartScreen icon={<span data-testid="icon" />}>
        <div />
      </StartScreen>,
      core,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "AssemblyAI" })).toBeNull();
  });

  test("omits the heading and subtitle it was not given", () => {
    const core = createMockSessionCore({ started: false });
    const { container } = renderWithProvider(
      <StartScreen>
        <div />
      </StartScreen>,
      core,
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
  });
});
