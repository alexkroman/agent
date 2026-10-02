// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * `ChatView` — the console shell over the message list and voice controls.
 *
 * Moved from `integration.test.tsx`: that it subscribes NARROWLY (a snapshot
 * field nothing under it reads re-renders nothing), and that the session error
 * it shows is announced.
 */
import { act, render, screen } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { BrowserSession } from "../session/index.ts";
import { ChatView } from "./chat-view.tsx";

function renderWithProvider(children: ReactNode, session: BrowserSession) {
  return render(
    <ThemeProvider>
      <SessionProvider value={session}>{children}</SessionProvider>
    </ThemeProvider>,
  );
}

describe("ChatView: narrow subscriptions", () => {
  test("does not re-render on snapshot changes no rendered component reads", () => {
    const core = createMockSessionCore({ started: true, state: "listening" });
    let commits = 0;
    render(
      <ThemeProvider>
        <SessionProvider value={core}>
          <Profiler id="chat-view" onRender={() => commits++}>
            <ChatView />
          </Profiler>
        </SessionProvider>
      </ThemeProvider>,
    );
    const before = commits;

    // `recording` is read by nothing in the audio-out tree; contentVersion is
    // pinned because the real core doesn't treat it as content. Nothing under
    // ChatView may re-render — with useSession() this fired the whole tree.
    act(() => core.update({ recording: true, contentVersion: core.getSnapshot().contentVersion }));
    expect(commits).toBe(before);

    // A field ChatView does read still re-renders it.
    act(() => core.update({ state: "thinking" }));
    expect(commits).toBeGreaterThan(before);
    expect(screen.getByText("thinking")).toBeInTheDocument();
  });
});

describe("ChatView: the shell", () => {
  test("the session error banner is ANNOUNCED, not just drawn", () => {
    // Per the `fatalError` latch this banner is the only remaining signal that
    // a live-looking session is dead, and a plain `<div>` appearing mid-page
    // tells a screen reader nothing. `Form` already uses `role="alert"` for the
    // same job.
    const core = createMockSessionCore({ started: true, running: true });
    renderWithProvider(<ChatView />, core);

    expect(screen.queryByRole("alert")).toBeNull();
    act(() =>
      core.update({
        state: "error",
        error: { code: "tts", message: "Cartesia TTS: missing API key.", fatal: true },
      }),
    );
    // Message AND code: the shell composes `<SessionErrorBanner>`, which shows
    // the code because it is the stable half of an error and the half a user
    // can quote back.
    expect(screen.getByRole("alert").textContent).toBe("Cartesia TTS: missing API key. (tts)");
  });

  test("shows the caller's title and the session state", () => {
    const core = createMockSessionCore({ started: true, state: "listening" });
    renderWithProvider(<ChatView title="Pizza Bot" />, core);
    expect(screen.getByText("Pizza Bot")).toBeInTheDocument();
    expect(screen.getByText("listening")).toBeInTheDocument();
    // The voice controls are always the footer: there is no text-only mode.
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });
});
