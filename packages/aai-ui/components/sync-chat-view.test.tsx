// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { SyncChatView } from "./sync-chat-view.tsx";

// The PTT recorder wraps getUserMedia + an AudioWorklet — mocked wholesale;
// what matters here is press → stop() PCM → one POST /sync → rendered output.
const micMock = vi.hoisted(() => ({
  createPttRecorder: vi.fn(),
  DEFAULT_SYNC_MIC_SAMPLE_RATE: 16_000,
}));
vi.mock("../sync-mic.ts", () => micMock);

/** A full second of speech — comfortably past the button-fumble guard. */
const SPEECH = new Int16Array(16_000);
/** A blip shorter than the quarter-second guard. */
const FUMBLE = new Int16Array(1000);

function mockRecorder(pcm: Int16Array = SPEECH) {
  const recorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => pcm),
    close: vi.fn(async () => undefined),
  };
  micMock.createPttRecorder.mockReturnValue(recorder);
  return recorder;
}

/** Minimal AudioContext stand-in for the reply-playback path. */
class FakePlaybackContext {
  static started = 0;
  destination = {};
  createBuffer(_channels: number, length: number, _rate: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      connect: () => undefined,
      start: () => {
        FakePlaybackContext.started++;
      },
    };
  }
  close() {
    return Promise.resolve();
  }
}

function renderView(props?: { title?: string; greeting?: string }) {
  return render(
    <ThemeProvider>
      <SyncChatView syncUrl="http://localhost:3000/sync" {...props} />
    </ThemeProvider>,
  );
}

function pttButton(): HTMLElement {
  return screen.getByTitle("Hold to record — release to send");
}

function stubTurn(body: Record<string, unknown>) {
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  micMock.createPttRecorder.mockReset();
  FakePlaybackContext.started = 0;
});

describe("SyncChatView", () => {
  test("shows the title and the greeting", () => {
    renderView({ title: "My Sync Agent", greeting: "Hold the button to talk to me." });
    expect(screen.getByText("My Sync Agent")).toBeTruthy();
    expect(screen.getByText("Hold the button to talk to me.")).toBeTruthy();
  });

  test("falls back to a generic title", () => {
    renderView();
    expect(screen.getByText("Voice Agent")).toBeTruthy();
  });

  test("shows where each utterance is sent", () => {
    renderView();
    expect(screen.getByTestId("sync-url-chip-url").textContent).toBe("http://localhost:3000/sync");
  });

  test("hold-and-release sends one POST /sync and renders heard + reply", async () => {
    const recorder = mockRecorder();
    const fetchSpy = stubTurn({ transcript: "what time is it", reply: "It is noon." });

    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("Release to send")).toBeTruthy();
    fireEvent.pointerUp(pttButton());

    expect(await screen.findByText("It is noon.")).toBeTruthy();
    expect(screen.getByText("what time is it")).toBeTruthy();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/sync",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { audio?: unknown; sampleRate?: unknown };
    expect(typeof body.audio).toBe("string");
    expect(body.sampleRate).toBe(16_000);
  });

  test("a sub-quarter-second press is dropped without a request", async () => {
    mockRecorder(FUMBLE);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("Release to send")).toBeTruthy();
    fireEvent.pointerUp(pttButton());

    expect(await screen.findByText("Hold to talk")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a spoken reply plays through an AudioContext", async () => {
    mockRecorder();
    vi.stubGlobal("AudioContext", FakePlaybackContext);
    // "AAAAAA==" is 4 bytes of PCM16 silence — 2 samples.
    stubTurn({ transcript: "t", reply: "r", audio: "AAAAAA==", sampleRate: 16_000 });

    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("Release to send")).toBeTruthy();
    fireEvent.pointerUp(pttButton());

    expect(await screen.findByText("r")).toBeTruthy();
    expect(FakePlaybackContext.started).toBe(1);
  });

  test("a TTS failure surfaces while the text reply stays intact", async () => {
    mockRecorder();
    stubTurn({ transcript: "t", reply: "r", ttsError: "no voice" });

    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("Release to send")).toBeTruthy();
    fireEvent.pointerUp(pttButton());

    expect(await screen.findByText("TTS unavailable: no voice")).toBeTruthy();
    expect(screen.getByText("r")).toBeTruthy();
  });

  test("a denied mic permission surfaces as an error", async () => {
    micMock.createPttRecorder.mockReturnValue({
      start: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      stop: vi.fn(),
      close: vi.fn(),
    });
    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("permission denied")).toBeTruthy();
  });

  test("a non-Error mic failure is stringified", async () => {
    micMock.createPttRecorder.mockReturnValue({
      // Rejecting with a bare string exercises the non-Error path.
      start: vi.fn().mockRejectedValue("nope"),
      stop: vi.fn(),
      close: vi.fn(),
    });
    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("nope")).toBeTruthy();
  });

  test("a failed turn surfaces the error instead of hanging on busy", async () => {
    mockRecorder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "kaput" }), { status: 500 })),
    );
    renderView();
    fireEvent.pointerDown(pttButton());
    expect(await screen.findByText("Release to send")).toBeTruthy();
    fireEvent.pointerUp(pttButton());
    expect(await screen.findByText(/Sync turn failed: HTTP 500/)).toBeTruthy();
  });
});
