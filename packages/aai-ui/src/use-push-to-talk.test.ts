// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * Every case here is one of the ways a hand-written hold-to-talk button leaves
 * a turn OPEN — microphone live, nothing answered — which is what the hook is
 * for (see its module doc). Asserted on the session methods the hook calls,
 * because those frames are the whole of what the server sees.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { type UsePushToTalkOptions, usePushToTalk } from "./use-push-to-talk.ts";

function mount(options?: UsePushToTalkOptions, snapshot = { running: true }) {
  const core = createMockSessionCore(snapshot);
  // Spied BEFORE the hook mounts: `useSessionActions` picks the methods once.
  const start = vi.spyOn(core, "startUserTurn");
  const commit = vi.spyOn(core, "commitUserTurn");
  const clear = vi.spyOn(core, "clearUserTurn");
  const hook = renderHook(() => usePushToTalk(options), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children),
  });
  return { core, hook, start, commit, clear };
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { code, cancelable: true, ...init }));
  });
}

const pointer = { currentTarget: document.createElement("button"), pointerId: 1 };

describe("usePushToTalk", () => {
  test("press opens the turn, release commits it, and the flag follows", () => {
    const { hook, start, commit } = mount();
    act(() => hook.result.current.press());
    expect(hook.result.current.talking).toBe(true);
    expect(hook.result.current.buttonProps["aria-pressed"]).toBe(true);
    act(() => hook.result.current.release());
    expect(hook.result.current.talking).toBe(false);
    expect(start).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  test("a second press while held and a release while idle are both ignored", () => {
    const { hook, start, commit } = mount();
    act(() => hook.result.current.release());
    act(() => hook.result.current.press());
    act(() => hook.result.current.press());
    expect(start).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  test("a held key's auto-repeat does not re-open the turn", () => {
    const { start, commit } = mount();
    key("keydown", "Space");
    key("keydown", "Space", { repeat: true });
    key("keydown", "Space", { repeat: true });
    key("keyup", "Space");
    expect(start).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  test("the window losing focus mid-hold commits the turn a lost keyup would have", () => {
    const { commit } = mount();
    key("keydown", "Space");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  test("the hold key is Space by default, configurable, and can be turned off", () => {
    const custom = mount({ holdKey: "KeyT" });
    key("keydown", "Space");
    expect(custom.start).not.toHaveBeenCalled();
    key("keydown", "KeyT");
    expect(custom.start).toHaveBeenCalledOnce();
    custom.hook.unmount();

    const off = mount({ holdKey: false });
    key("keydown", "Space");
    expect(off.start).not.toHaveBeenCalled();
  });

  test("Space typed into a text field is a character, not a press", () => {
    const { start } = mount();
    const input = document.createElement("input");
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    expect(start).not.toHaveBeenCalled();
    input.remove();
  });

  test("a cancelled pointer DISCARDS the turn rather than answering half of it", () => {
    const { hook, commit, clear } = mount();
    act(() => hook.result.current.buttonProps.onPointerDown(pointer));
    act(() => hook.result.current.buttonProps.onPointerCancel());
    expect(clear).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  test("the pointer is captured, so a release off the button still arrives", () => {
    const { hook } = mount();
    const target = document.createElement("button");
    const capture = vi.fn();
    target.setPointerCapture = capture;
    act(() =>
      hook.result.current.buttonProps.onPointerDown({ currentTarget: target, pointerId: 7 }),
    );
    expect(capture).toHaveBeenCalledWith(7);
  });

  test("unmounting mid-hold discards the turn", () => {
    const { hook, clear, commit } = mount();
    act(() => hook.result.current.press());
    hook.unmount();
    expect(clear).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  test("a call that is not live disables the button and presses nothing", () => {
    const { hook, start } = mount(undefined, { running: false });
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.buttonProps.disabled).toBe(true);
    act(() => hook.result.current.press());
    expect(start).not.toHaveBeenCalled();
    expect(hook.result.current.talking).toBe(false);
  });
});
