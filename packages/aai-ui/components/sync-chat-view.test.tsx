// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import type { SyncMicrophoneOptions } from "../sync-mic.ts";
import { SyncChatView } from "./sync-chat-view.tsx";

// The VAD microphone wraps getUserMedia + an AudioWorklet — mocked wholesale;
// what matters here is toggle → endpointed utterance → one POST /sync →
// rendered output. Utterances are simulated by driving the options the view
// hands to startSyncMicrophone (speech callbacks + the session's sendPcm16),
// exactly what the real mic does per endpointed utterance.
const micMock = vi.hoisted(() => ({
  startSyncMicrophone: vi.fn(),
  DEFAULT_SYNC_MIC_SAMPLE_RATE: 16_000,
}));
vi.mock("../sync-mic.ts", () => micMock);

/** A second of speech, as the VAD would hand it over. */
const SPEECH = new Int16Array(16_000);

function mockMic() {
  const handle = { speaking: false, stop: vi.fn(async () => undefined) };
  const captured: { opts: SyncMicrophoneOptions | null } = { opts: null };
  micMock.startSyncMicrophone.mockImplementation(async (opts: SyncMicrophoneOptions) => {
    captured.opts = opts;
    return handle;
  });
  return { handle, captured };
}

/** Drive one VAD-endpointed utterance through the captured mic options. */
async function speakUtterance(
  captured: { opts: SyncMicrophoneOptions | null },
  pcm: Int16Array = SPEECH,
): Promise<void> {
  const opts = captured.opts;
  if (!opts) throw new Error("mic not started");
  await act(async () => {
    opts.onSpeechStart?.();
    opts.onSpeechEnd?.();
    await opts.session.sendPcm16(pcm, 16_000).catch(() => {
      // surfaced via onError
    });
  });
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
      onended: null as (() => void) | null,
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

function toggleButton(): HTMLElement {
  return screen.getByTitle("Start or end the conversation");
}

async function startConversation(): Promise<void> {
  fireEvent.click(toggleButton());
  // findByText throws if the live label never appears.
  await screen.findByText("End conversation");
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
  micMock.startSyncMicrophone.mockReset();
  FakePlaybackContext.started = 0;
});

describe("SyncChatView", () => {
  test("shows the title and the greeting", () => {
    renderView({ title: "My Sync Agent", greeting: "Start the conversation and talk to me." });
    expect(screen.getByText("My Sync Agent")).toBeTruthy();
    expect(screen.getByText("Start the conversation and talk to me.")).toBeTruthy();
  });

  test("falls back to a generic title", () => {
    renderView();
    expect(screen.getByText("Voice Agent")).toBeTruthy();
  });

  test("shows where each utterance is sent", () => {
    renderView();
    expect(screen.getByTestId("sync-url-chip-url").textContent).toBe("http://localhost:3000/sync");
  });

  test("an endpointed utterance sends one POST /sync and renders heard + reply", async () => {
    const { captured } = mockMic();
    const fetchSpy = stubTurn({ transcript: "what time is it", reply: "It is noon." });

    renderView();
    await startConversation();
    await speakUtterance(captured);

    expect(await screen.findByText("It is noon.")).toBeTruthy();
    expect(screen.getByText("what time is it")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/sync",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { audio?: unknown; sampleRate?: unknown };
    expect(typeof body.audio).toBe("string");
    expect(body.sampleRate).toBe(16_000);
  });

  test("the mic stays open across turns — a second utterance needs no button", async () => {
    const { captured } = mockMic();
    const fetchSpy = stubTurn({ transcript: "again", reply: "Sure." });

    renderView();
    await startConversation();
    await speakUtterance(captured);
    await speakUtterance(captured);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(micMock.startSyncMicrophone).toHaveBeenCalledOnce();
  });

  test("ending the conversation stops the mic", async () => {
    const { handle } = mockMic();
    renderView();
    await startConversation();

    fireEvent.click(toggleButton());
    expect(await screen.findByText("Start conversation")).toBeTruthy();
    expect(handle.stop).toHaveBeenCalledOnce();
  });

  test("a spoken reply plays through an AudioContext", async () => {
    const { captured } = mockMic();
    vi.stubGlobal("AudioContext", FakePlaybackContext);
    // "AAAAAA==" is 4 bytes of PCM16 silence — 2 samples.
    stubTurn({ transcript: "t", reply: "r", audio: "AAAAAA==", sampleRate: 16_000 });

    renderView();
    await startConversation();
    await speakUtterance(captured);

    expect(await screen.findByText("r")).toBeTruthy();
    expect(FakePlaybackContext.started).toBe(1);
  });

  test("a TTS failure surfaces while the text reply stays intact", async () => {
    const { captured } = mockMic();
    stubTurn({ transcript: "t", reply: "r", ttsError: "no voice" });

    renderView();
    await startConversation();
    await speakUtterance(captured);

    expect(await screen.findByText("TTS unavailable: no voice")).toBeTruthy();
    expect(screen.getByText("r")).toBeTruthy();
  });

  test("a denied mic permission surfaces as an error", async () => {
    micMock.startSyncMicrophone.mockRejectedValue(new Error("permission denied"));
    renderView();
    fireEvent.click(toggleButton());
    expect(await screen.findByText("permission denied")).toBeTruthy();
    // The conversation never went live.
    expect(screen.getByText("Start conversation")).toBeTruthy();
  });

  test("a non-Error mic failure is stringified", async () => {
    // Rejecting with a bare string exercises the non-Error path.
    micMock.startSyncMicrophone.mockRejectedValue("nope");
    renderView();
    fireEvent.click(toggleButton());
    expect(await screen.findByText("nope")).toBeTruthy();
  });

  test("a mid-conversation capture error surfaces without ending the session", async () => {
    const { captured } = mockMic();
    renderView();
    await startConversation();

    act(() => {
      captured.opts?.onError?.(new Error("worklet crashed"));
    });

    expect(await screen.findByText("worklet crashed")).toBeTruthy();
    expect(screen.getByText("End conversation")).toBeTruthy();
  });

  test("unmounting releases the mic", async () => {
    const { handle } = mockMic();
    const view = renderView();
    await startConversation();

    view.unmount();

    expect(handle.stop).toHaveBeenCalledOnce();
  });

  test("unmounting mid-startup still releases the mic", async () => {
    // The permission prompt is open when the view goes away: the cleanup runs
    // before startSyncMicrophone resolves, so nothing holds the handle. Left
    // unstopped it is a hot mic and an AudioContext for the page's lifetime,
    // still POSTing endpointed utterances from a view that no longer exists.
    const handle = { speaking: false, stop: vi.fn(async () => undefined) };
    let grant: (() => void) | null = null;
    micMock.startSyncMicrophone.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          grant = () => resolve(handle);
        }),
    );

    const view = renderView();
    fireEvent.click(toggleButton());
    view.unmount();
    await act(async () => {
      grant?.();
    });

    expect(handle.stop).toHaveBeenCalledOnce();
  });

  test("a turn landing after unmount neither plays nor throws", async () => {
    const { captured } = mockMic();
    vi.stubGlobal("AudioContext", FakePlaybackContext);
    stubTurn({ transcript: "t", reply: "r", audio: "AAAAAA==", sampleRate: 16_000 });

    const view = renderView();
    await startConversation();
    view.unmount();
    await speakUtterance(captured);

    // No AudioContext resurrected for a view that is gone.
    expect(FakePlaybackContext.started).toBe(0);
  });

  test("a failed turn surfaces the error instead of hanging on thinking", async () => {
    const { captured } = mockMic();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "kaput" }), { status: 500 })),
    );
    renderView();
    await startConversation();
    await speakUtterance(captured);
    expect(await screen.findByText(/Sync turn failed: HTTP 500/)).toBeTruthy();
    expect(screen.queryByTestId("thinking")).toBeNull();
  });
});
