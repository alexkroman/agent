// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useTapToTalk` over a mock session: the session methods a tap, a hang-up
 * and a typed turn reach, the talk key, and the phase it derives. The clocks
 * themselves are `_tap-to-talk-state.test.ts`'s; one is exercised here to prove
 * the hook feeds the machine session activity.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import type { SessionSnapshot } from "./session/index.ts";
import { type UseTapToTalkOptions, useTapToTalk } from "./use-tap-to-talk.ts";

function mount(options?: UseTapToTalkOptions, snapshot: Partial<SessionSnapshot> = {}) {
  const core = createMockSessionCore({ running: false, ...snapshot });
  const disconnect = vi.spyOn(core, "disconnect").mockImplementation(() => {
    core.update({ running: false, state: "disconnected" });
  });
  const cancel = vi.spyOn(core, "cancel");
  const sendText = vi.spyOn(core, "sendText");
  const start = vi.spyOn(core, "start");
  const toggle = vi.spyOn(core, "toggle");
  const hook = renderHook(() => useTapToTalk(options), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children),
  });
  return { core, hook, disconnect, cancel, sendText, start, toggle };
}

function key(code: string, init: KeyboardEventInit & { target?: EventTarget } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { code, cancelable: true, bubbles: true, ...init });
  act(() => {
    (init.target ?? window).dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTapToTalk", () => {
  test("idle, the mic is muted; a tap opens it and starts the session", () => {
    const { core, hook, start } = mount();
    expect(core.getSnapshot().micMuted).toBe(true);
    expect(hook.result.current).toMatchObject({ phase: "idle", live: false });
    act(() => hook.result.current.toggle());
    expect(start).toHaveBeenCalledOnce();
    expect(core.getSnapshot().micMuted).toBe(false);
    expect(hook.result.current.live).toBe(true);
    expect(hook.result.current.buttonProps["aria-pressed"]).toBe(true);
  });

  test("after a hang-up a tap RESUMES (toggle), never start", () => {
    const { hook, start, toggle } = mount({}, { started: true });
    act(() => hook.result.current.toggle());
    expect(toggle).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  test("the next tap cancels the reply and disconnects — resumably, not end()", () => {
    const { core, hook, cancel, disconnect } = mount();
    const end = vi.spyOn(core, "end");
    act(() => hook.result.current.toggle());
    act(() => core.update({ state: "speaking" }));
    expect(hook.result.current.phase).toBe("active");
    act(() => hook.result.current.toggle());
    expect(cancel).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(hook.result.current).toMatchObject({ phase: "idle", live: false });
    expect(core.getSnapshot().micMuted).toBe(true);
  });

  test("a typed turn asks the session to connect for it, and leaves the mic muted", () => {
    const { core, hook, sendText } = mount();
    act(() => hook.result.current.send("  what's on today "));
    act(() => hook.result.current.send("   "));
    expect(sendText).toHaveBeenCalledExactlyOnceWith("  what's on today ", { connect: true });
    expect(core.getSnapshot().micMuted).toBe(true);
  });

  test("a call opened by typing hangs up after the quiet window", () => {
    const { core, disconnect } = mount({ idleHangupMs: 1000 });
    act(() => core.update({ running: true, state: "connecting" }));
    act(() => core.update({ state: "listening" }));
    act(() => {
      vi.advanceTimersByTime(900);
    });
    act(() => core.update({ agentTranscript: "Sure" })); // activity
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("a transcript delta restarts the quiet clock without re-rendering the host", () => {
    const core = createMockSessionCore({ running: false });
    const disconnect = vi.spyOn(core, "disconnect");
    let renders = 0;
    renderHook(
      () => {
        renders++;
        return useTapToTalk({ idleHangupMs: 1000 });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(SessionProvider, { value: core }, children),
      },
    );
    act(() => core.update({ running: true, state: "connecting" }));
    act(() => core.update({ state: "listening" }));
    const before = renders;
    for (const text of ["S", "Su", "Sur", "Sure"]) {
      act(() => {
        vi.advanceTimersByTime(900);
      });
      act(() => core.update({ agentTranscript: text }));
    }
    expect(renders).toBe(before);
    expect(disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("a session error marks the attempt failed", () => {
    const { core, hook } = mount();
    act(() =>
      core.update({ error: { code: "connection", message: "nope", fatal: false }, state: "error" }),
    );
    expect(hook.result.current.failed).toBe(true);
  });

  test("Space taps once per press, never from a text field, and is configurable", () => {
    const { hook } = mount();
    const first = key("Space");
    expect(first.defaultPrevented).toBe(true);
    key("Space", { repeat: true });
    expect(hook.result.current.live).toBe(true);
    const input = document.body.appendChild(document.createElement("input"));
    key("Space", { target: input });
    expect(hook.result.current.live).toBe(true);
    input.remove();

    const custom = mount({ key: "KeyT" });
    key("Space");
    expect(custom.hook.result.current.live).toBe(false);
    key("KeyT");
    expect(custom.hook.result.current.live).toBe(true);
  });

  test("the button suppresses its own Space activation so a press is one tap", () => {
    const { hook } = mount();
    const preventDefault = vi.fn();
    hook.result.current.buttonProps.onKeyUp({ code: "Space", preventDefault });
    hook.result.current.buttonProps.onKeyDown({ code: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
