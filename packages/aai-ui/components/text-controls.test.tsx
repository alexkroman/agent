// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import { TextControls } from "./text-controls.tsx";
import { ApiUrlChip, SessionUrlChips, UiUrlChip } from "./url-chips.tsx";

function renderWithSession(
  ui: React.ReactElement,
  overrides?: Parameters<typeof createMockSessionCore>[0],
) {
  const session = createMockSessionCore(overrides);
  const utils = render(
    <ThemeProvider>
      <SessionProvider value={session}>{ui}</SessionProvider>
    </ThemeProvider>,
  );
  return { session, ...utils };
}

describe("TextControls", () => {
  test("record button toggles recording via the session core", () => {
    const { session } = renderWithSession(<TextControls />, {
      state: "listening",
      audioOut: false,
    });
    const button = screen.getByTestId("record-button");
    expect(button.textContent).toContain("Record");

    fireEvent.click(button);
    expect(session.getSnapshot().recording).toBe(true);
    expect(screen.getByTestId("record-button").textContent).toContain("Stop recording");

    fireEvent.click(screen.getByTestId("record-button"));
    expect(session.getSnapshot().recording).toBe(false);
  });

  test("record and upload are disabled while disconnected", () => {
    renderWithSession(<TextControls />, { state: "disconnected", audioOut: false });
    expect(screen.getByTestId("record-button")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("upload-button")).toHaveProperty("disabled", true);
  });

  test("choosing a file hands it to sendAudioFile", async () => {
    const { session } = renderWithSession(<TextControls />, {
      state: "listening",
      audioOut: false,
    });
    const sendAudioFile = vi.spyOn(session, "sendAudioFile");
    const input = screen.getByTestId("upload-input") as HTMLInputElement;
    const file = new File(["riff"], "note.wav", { type: "audio/wav" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(sendAudioFile).toHaveBeenCalledWith(file);
  });

  test("record is disabled while an upload is transcribing", async () => {
    const { session } = renderWithSession(<TextControls />, {
      state: "listening",
      audioOut: false,
    });
    const uploadGate = Promise.withResolvers<void>();
    vi.spyOn(session, "sendAudioFile").mockImplementation(() => uploadGate.promise);
    const input = screen.getByTestId("upload-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "x.wav", { type: "audio/wav" })] },
    });
    // Mid-upload: the mic must stay off so streams can't interleave.
    expect(screen.getByTestId("record-button")).toHaveProperty("disabled", true);
    uploadGate.resolve();
    await vi.waitFor(() => {
      expect(screen.getByTestId("record-button")).toHaveProperty("disabled", false);
    });
  });

  test("a failed upload surfaces its error message", async () => {
    const { session } = renderWithSession(<TextControls />, {
      state: "listening",
      audioOut: false,
    });
    vi.spyOn(session, "sendAudioFile").mockRejectedValue(new Error("cannot decode"));
    const input = screen.getByTestId("upload-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "x.wav", { type: "audio/wav" })] },
    });
    expect(await screen.findByTestId("upload-error")).toBeDefined();
    expect(screen.getByTestId("upload-error").textContent).toContain("cannot decode");
  });

  test("renders the API URL chip", () => {
    renderWithSession(<TextControls />, {
      state: "listening",
      audioOut: false,
      apiUrl: "wss://example.com/my-agent/websocket",
    });
    expect(screen.getByTestId("api-url-chip-url").textContent).toBe(
      "wss://example.com/my-agent/websocket",
    );
  });
});

describe("ApiUrlChip", () => {
  test("shows the session's programmatic endpoint", () => {
    renderWithSession(<ApiUrlChip />, { apiUrl: "wss://host/agent/websocket" });
    expect(screen.getByTestId("api-url-chip-url").textContent).toBe("wss://host/agent/websocket");
  });

  test("copies the URL to the clipboard on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithSession(<ApiUrlChip />, { apiUrl: "wss://host/agent/websocket" });
    fireEvent.click(screen.getByTestId("api-url-chip"));
    expect(writeText).toHaveBeenCalledWith("wss://host/agent/websocket");
    expect(await screen.findByText("Copied")).toBeDefined();
  });
});

describe("UiUrlChip", () => {
  it("shows the page URL without the query string or hash", () => {
    renderWithSession(<UiUrlChip />, { apiUrl: "wss://host/agent/websocket" });
    // jsdom's default location; the point is origin + pathname only.
    expect(screen.getByTestId("ui-url-chip-url").textContent).toBe(
      `${window.location.origin}${window.location.pathname}`,
    );
  });
});

describe("SessionUrlChips", () => {
  it("renders both URLs, each with its own label", () => {
    // A bare pair of URLs is unreadable — the labels are the point.
    renderWithSession(<SessionUrlChips />, { apiUrl: "wss://host/agent/websocket" });
    expect(screen.getByTestId("ui-url-chip")).toBeTruthy();
    expect(screen.getByTestId("api-url-chip")).toBeTruthy();
    expect(screen.getByTestId("ui-url-chip").textContent).toContain("UI");
    expect(screen.getByTestId("api-url-chip").textContent).toContain("API");
    expect(screen.getByTestId("api-url-chip-url").textContent).toBe("wss://host/agent/websocket");
  });
});
