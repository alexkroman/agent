// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { WorkflowView } from "./workflow-view.tsx";

// The recorder wraps getUserMedia + an AudioWorklet — mocked wholesale; what
// matters here is hold → staged clip → Go → ONE history-less sync request →
// rendered run report.
const micMock = vi.hoisted(() => ({
  createPttRecorder: vi.fn(),
  DEFAULT_SYNC_MIC_SAMPLE_RATE: 16_000,
}));
vi.mock("../sync-mic.ts", () => micMock);

const sessionMock = vi.hoisted(() => ({
  session: {
    history: [] as never[],
    sendText: vi.fn(),
    sendPcm16: vi.fn(),
    reset: vi.fn(),
  },
  createSyncSession: vi.fn(),
}));
vi.mock("../sync-session.ts", () => ({
  createSyncSession: sessionMock.createSyncSession.mockReturnValue(sessionMock.session),
}));

const audioMock = vi.hoisted(() => ({ decodeAudioToPcm16: vi.fn() }));
vi.mock("../audio.ts", () => audioMock);

/** A second of speech, as the recorder would hand it over on release. */
const SPEECH = new Int16Array(16_000);

function mockRecorder(pcm: Int16Array = SPEECH) {
  const recorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => pcm),
    close: vi.fn(async () => undefined),
  };
  micMock.createPttRecorder.mockReturnValue(recorder);
  return recorder;
}

function renderView() {
  return render(
    <ThemeProvider value={undefined}>
      <WorkflowView syncUrl="http://host/wf/sync" title="Expense Filer" greeting="Speak it." />
    </ThemeProvider>,
  );
}

async function holdAndRelease(): Promise<void> {
  const hold = screen.getByTitle("Hold to record your instructions");
  await act(async () => {
    fireEvent.pointerDown(hold);
  });
  await act(async () => {
    fireEvent.pointerUp(hold);
  });
}

afterEach(() => {
  vi.clearAllMocks();
  sessionMock.createSyncSession.mockReturnValue(sessionMock.session);
});

describe("WorkflowView", () => {
  test("renders the run surface idle state", () => {
    renderView();
    expect(screen.getByText("Expense Filer")).toBeTruthy();
    expect(screen.getByText("Speak it.")).toBeTruthy();
    expect(screen.getByText(/Hold to talk or upload an audio file/)).toBeTruthy();
    expect((screen.getByTestId("workflow-go") as HTMLButtonElement).disabled).toBe(true);
  });

  test("hold-to-talk stages a clip and enables Go", async () => {
    const recorder = mockRecorder();
    renderView();
    await holdAndRelease();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("staged-clip").textContent).toContain("Recording staged (1.0s)");
    expect((screen.getByTestId("workflow-go") as HTMLButtonElement).disabled).toBe(false);
  });

  test("Go runs the staged clip as one history-less turn and shows the report", async () => {
    mockRecorder();
    sessionMock.session.sendPcm16.mockResolvedValue({
      transcript: "file a 12 dollar lunch",
      reply: "Filed one expense: $12, lunch.",
      pcm: null,
    });
    renderView();
    await holdAndRelease();
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-go"));
    });
    // Each run stands alone: the session history is cleared before the turn.
    expect(sessionMock.session.reset).toHaveBeenCalledTimes(1);
    expect(sessionMock.session.sendPcm16).toHaveBeenCalledWith(SPEECH, 16_000);
    const result = screen.getByTestId("run-result");
    expect(result.textContent).toContain("file a 12 dollar lunch");
    expect(result.textContent).toContain("Filed one expense: $12, lunch.");
    // The staged clip is consumed; Go disarms until a new clip is staged.
    expect((screen.getByTestId("workflow-go") as HTMLButtonElement).disabled).toBe(true);
  });

  test("uploading an audio file stages a decoded clip", async () => {
    audioMock.decodeAudioToPcm16.mockResolvedValue(new Int16Array(32_000));
    renderView();
    const file = new File([new Uint8Array(4)], "memo.m4a", { type: "audio/mp4" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("workflow-file-input"), { target: { files: [file] } });
    });
    expect(audioMock.decodeAudioToPcm16).toHaveBeenCalledWith(expect.any(ArrayBuffer), 16_000);
    expect(screen.getByTestId("staged-clip").textContent).toContain("memo.m4a staged (2.0s)");
  });

  test("a failed run surfaces the error and keeps the view usable", async () => {
    mockRecorder();
    sessionMock.session.sendPcm16.mockRejectedValue(new Error("Sync turn failed: HTTP 503"));
    renderView();
    await holdAndRelease();
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-go"));
    });
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    // The clip survives a failed run so the user can just press Go again.
    expect((screen.getByTestId("workflow-go") as HTMLButtonElement).disabled).toBe(false);
  });

  test("an empty recording is rejected with guidance instead of staging", async () => {
    mockRecorder(new Int16Array(0));
    renderView();
    await holdAndRelease();
    expect(screen.getByText(/hold the button while you speak/i)).toBeTruthy();
    expect((screen.getByTestId("workflow-go") as HTMLButtonElement).disabled).toBe(true);
  });

  test("an undecodable file is rejected with an error", async () => {
    audioMock.decodeAudioToPcm16.mockRejectedValue(new Error("bad"));
    renderView();
    const file = new File([new Uint8Array(4)], "notes.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("workflow-file-input"), { target: { files: [file] } });
    });
    expect(screen.getByText(/Could not decode that file as audio/)).toBeTruthy();
  });
});
