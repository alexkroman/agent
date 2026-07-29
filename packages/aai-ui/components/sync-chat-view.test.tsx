// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import type { SyncMicrophoneOptions } from "../sync-mic.ts";
import { SyncChatView } from "./sync-chat-view.tsx";

const micMock = vi.hoisted(() => ({ startSyncMicrophone: vi.fn() }));
vi.mock("../sync-mic.ts", () => micMock);

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

afterEach(() => {
  vi.unstubAllGlobals();
  micMock.startSyncMicrophone.mockReset();
  FakePlaybackContext.started = 0;
});

describe("SyncChatView", () => {
  test("shows the title and the greeting as the opening assistant line", () => {
    renderView({ title: "My Sync Agent", greeting: "Hello! Type below." });
    expect(screen.getByText("My Sync Agent")).toBeTruthy();
    expect(screen.getByText("Hello! Type below.")).toBeTruthy();
  });

  test("falls back to a generic title", () => {
    renderView();
    expect(screen.getByText("Voice Agent")).toBeTruthy();
  });

  test("a typed message runs one POST /sync turn and renders both sides", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string; history: unknown[] };
      expect(body.text).toBe("hi there");
      expect(body.history).toEqual([]);
      return new Response(JSON.stringify({ transcript: "hi there", reply: "Hello back!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "hi there" },
    });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("Hello back!")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("Enter in the composer runs a turn", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ transcript: "yo", reply: "hey" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "yo" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Type a message…"), { key: "Enter" });
    expect(await screen.findByText("hey")).toBeTruthy();
  });

  test("a spoken reply plays through an AudioContext", async () => {
    vi.stubGlobal("AudioContext", FakePlaybackContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            // "AAAAAA==" is 4 bytes of PCM16 silence — 2 samples.
            JSON.stringify({ transcript: "t", reply: "r", audio: "AAAAAA==", sampleRate: 16_000 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "t" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("r")).toBeTruthy();
    expect(FakePlaybackContext.started).toBe(1);
  });

  test("a TTS failure surfaces while the text reply stays intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ transcript: "t", reply: "r", ttsError: "no voice" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "t" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("TTS unavailable: no voice")).toBeTruthy();
    expect(screen.getByText("r")).toBeTruthy();
  });

  test("the mic toggle starts the VAD microphone and stops it on the next tap", async () => {
    const stop = vi.fn(async () => undefined);
    let opts: SyncMicrophoneOptions | undefined;
    micMock.startSyncMicrophone.mockImplementation(async (o: SyncMicrophoneOptions) => {
      opts = o;
      return { speaking: false, stop };
    });
    renderView();

    fireEvent.click(screen.getByTitle("Start listening"));
    expect(await screen.findByTitle("Stop listening")).toBeTruthy();

    // An endpointed utterance flips the busy indicator on…
    act(() => opts?.onSpeechEnd?.());
    expect(screen.getByTestId("thinking")).toBeTruthy();
    // …and a capture failure surfaces without killing the mic.
    act(() => opts?.onError?.(new Error("mic glitch")));
    expect(screen.getByText("mic glitch")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Stop listening"));
    expect(await screen.findByTitle("Start listening")).toBeTruthy();
    expect(stop).toHaveBeenCalledOnce();
  });

  test("a denied mic permission surfaces as an error", async () => {
    micMock.startSyncMicrophone.mockRejectedValueOnce(new Error("permission denied"));
    renderView();
    fireEvent.click(screen.getByTitle("Start listening"));
    expect(await screen.findByText("permission denied")).toBeTruthy();
  });

  test("a non-Error mic failure is stringified", async () => {
    micMock.startSyncMicrophone.mockRejectedValueOnce("nope");
    renderView();
    fireEvent.click(screen.getByTitle("Start listening"));
    expect(await screen.findByText("nope")).toBeTruthy();
  });

  test("a failed turn surfaces the error instead of hanging on busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "kaput" }), { status: 500 })),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText(/Sync turn failed: HTTP 500/)).toBeTruthy();
  });
});
