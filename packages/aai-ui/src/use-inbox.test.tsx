// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `useInbox` over a mock session: it holds the inbox under the SESSION's client
 * and this tab's holder, is busy while the session runs (so a reminder never
 * talks over a reply), plays a notice only once a gesture has unlocked audio,
 * and reads its callbacks at call time rather than reconnecting for new ones.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { type MockWebSocket, recordingWebSocketClass } from "./_session-core-test-utils.ts";
import { SessionProvider } from "./context.ts";
import type { NoticeBuffer } from "./notice-player.ts";
import { type UseInboxOptions, useInbox } from "./use-inbox.ts";

type FakeSource = {
  buffer: NoticeBuffer | null;
  onended: (() => unknown) | null;
  connect: Mock<(destination: unknown) => unknown>;
  start: Mock<() => void>;
  stop: Mock<() => void>;
};

/** The page's `AudioContext`, as far as the notice player reaches into it. */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  constructor() {
    FakeAudioContext.made.push(this);
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => undefined);
  createBuffer(_channels: number, length: number): NoticeBuffer {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  }
  createBufferSource(): FakeSource {
    const src: FakeSource = {
      buffer: null,
      onended: null,
      connect: vi.fn<(destination: unknown) => unknown>(),
      start: vi.fn<() => void>(),
      stop: vi.fn<() => void>(),
    };
    this.sources.push(src);
    return src;
  }
}

let sockets: MockWebSocket[] = [];
const last = () => sockets.at(-1);
const replies = () => (last()?.send.mock.calls ?? []).map((call) => JSON.parse(String(call[0])));
const notice = (id: string) =>
  JSON.stringify({ type: "notice", id, event: "reminder", bytes: 2, data: { text: "plumber" } });

function mount(options: UseInboxOptions = {}, running = false) {
  const core = createMockSessionCore(
    { running },
    {
      platformUrl: "http://speaker.local/",
      clientId: () => "kitchen",
      holderId: () => "kitchen-tab1",
    },
  );
  const hook = renderHook((opts: UseInboxOptions) => useInbox(opts), {
    initialProps: options,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children),
  });
  return { core, hook };
}

/** Deliver one whole two-byte notice on the current socket. */
function deliver(id: string): void {
  act(() => {
    last()?.simulateMessage(notice(id));
    last()?.simulateMessage(new Uint8Array([1, 0]));
  });
}

beforeEach(() => {
  sockets = [];
  FakeAudioContext.made = [];
  vi.stubGlobal(
    "WebSocket",
    recordingWebSocketClass((s) => sockets.push(s)),
  );
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInbox", () => {
  test("holds the session's client under this tab's holder, and reports connected", () => {
    const { hook } = mount();
    const url = new URL(last()?.url ?? "");
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("ws://speaker.local/inbox");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: "kitchen",
      holder: "kitchen-tab1",
    });
    expect(hook.result.current.connected).toBe(false);
    act(() => last()?.simulateOpen());
    expect(hook.result.current.connected).toBe(true);
    hook.unmount();
    expect(last()?.close).toHaveBeenCalled();
  });

  test("is busy while the session runs, so a reminder never talks over a reply", () => {
    const onNotice = vi.fn();
    mount({ onNotice }, true);
    act(() => last()?.simulateMessage(notice("r1")));
    expect(replies()).toEqual([{ type: "busy", id: "r1" }]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  test("a caller's busy wins over the default", () => {
    const onNotice = vi.fn();
    mount({ onNotice, busy: () => false }, true);
    deliver("r1");
    expect(onNotice).toHaveBeenCalledOnce();
    expect(replies()).toEqual([{ type: "ack", id: "r1" }]);
  });

  test("plays a notice once a gesture unlocked audio, and stopPlayback silences it", () => {
    const { hook } = mount();
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    const [ctx] = FakeAudioContext.made;
    expect(ctx?.resume).toHaveBeenCalled();
    deliver("r1");
    expect(ctx?.sources[0]?.start).toHaveBeenCalledOnce();
    act(() => hook.result.current.stopPlayback());
    expect(ctx?.sources[0]?.stop).toHaveBeenCalledOnce();
  });

  test("play: false leaves the audio to the caller", () => {
    const onNotice = vi.fn();
    mount({ onNotice, play: false });
    deliver("r1");
    expect(onNotice.mock.calls[0]?.[0]).toMatchObject({ id: "r1", pcm: new Uint8Array([1, 0]) });
    expect(FakeAudioContext.made).toHaveLength(0);
  });

  test("new callbacks are used without reconnecting; asking for events does reconnect", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { hook } = mount({ onNotice: first });
    hook.rerender({ onNotice: second });
    expect(sockets).toHaveLength(1);
    deliver("r1");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    const onEvent = vi.fn();
    hook.rerender({ onNotice: second, onEvent });
    expect(sockets).toHaveLength(2);
    expect(new URL(last()?.url ?? "").searchParams.get("events")).toBe("1");
    act(() => last()?.simulateMessage(JSON.stringify({ type: "session_ended", sessionId: "s1" })));
    expect(onEvent).toHaveBeenCalledWith({ type: "session_ended", sessionId: "s1" });
  });
});
