// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The hook is two one-field subscriptions and four bound methods, and the two
 * claims worth pinning are the ones a control row cannot check for itself:
 * that a snapshot change to anything OTHER than the two flags does not
 * re-render it (the whole-snapshot `useSession()` this replaces did, at
 * STT-partial rate), and that the methods are the session's own — `restart`
 * in particular is the `end(); start()` pair and not `reset()`.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { useSessionControls } from "./use-session-controls.ts";

/**
 * `prepare` runs on the core BEFORE the hook mounts: `useSessionActions` picks
 * the methods off the core once, so a spy installed after render is a spy on a
 * function nothing holds any more.
 */
function mount(
  overrides?: Parameters<typeof createMockSessionCore>[0],
  prepare?: (core: ReturnType<typeof createMockSessionCore>) => void,
) {
  const core = createMockSessionCore(overrides);
  prepare?.(core);
  let renders = 0;
  const hook = renderHook(
    () => {
      renders++;
      return useSessionControls();
    },
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(SessionProvider, { value: core }, children),
    },
  );
  return { core, hook, renders: () => renders };
}

describe("useSessionControls", () => {
  test("reports the two flags", () => {
    const { hook } = mount({ started: true, running: false });
    expect(hook.result.current.started).toBe(true);
    expect(hook.result.current.running).toBe(false);
  });

  test("hands back the session's own methods", () => {
    const spies: Record<string, ReturnType<typeof vi.spyOn>> = {};
    const { hook } = mount({ started: true, running: true }, (core) => {
      spies.start = vi.spyOn(core, "start");
      spies.toggle = vi.spyOn(core, "toggle");
      spies.end = vi.spyOn(core, "end");
    });
    const { start, toggle, end } = spies;
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.end());
    act(() => hook.result.current.start());
    expect(toggle).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  test("`restart` is end() then start(), never reset()", () => {
    // The whole reason three chromes wrote the pair by hand: `reset()` keeps
    // the session id, so every server-side slot survives a "new conversation".
    const calls: string[] = [];
    let reset: ReturnType<typeof vi.spyOn> | undefined;
    const { hook } = mount({ started: true, running: true }, (core) => {
      vi.spyOn(core, "end").mockImplementation(() => {
        calls.push("end");
      });
      vi.spyOn(core, "start").mockImplementation(() => {
        calls.push("start");
      });
      reset = vi.spyOn(core, "reset");
    });
    act(() => hook.result.current.restart());
    expect(calls).toEqual(["end", "start"]);
    expect(reset).not.toHaveBeenCalled();
  });

  test("re-renders when a flag flips, and the result is a new object then", () => {
    const { core, hook } = mount({ started: false, running: false });
    const before = hook.result.current;
    act(() => core.start());
    expect(hook.result.current).not.toBe(before);
    expect(hook.result.current.started).toBe(true);
    expect(hook.result.current.running).toBe(true);
  });

  test("does NOT re-render on a snapshot change to anything else", () => {
    // A control row re-rendering at STT-partial rate is the defect the
    // one-field subscriptions exist to end.
    const { core, hook, renders } = mount({ started: true, running: true });
    const before = renders();
    const result = hook.result.current;
    act(() => core.update({ userTranscript: "hel" }));
    act(() => core.update({ userTranscript: "hello", state: "listening" }));
    act(() => core.update({ agentTranscript: "Hi there" }));
    expect(renders()).toBe(before);
    expect(hook.result.current).toBe(result);
  });
});
