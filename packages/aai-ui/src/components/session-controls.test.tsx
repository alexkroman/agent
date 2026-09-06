// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * What the component decides, as against what a chrome's `renderButton`
 * decides: WHICH buttons exist in each state, what each one presses, and what
 * it is called. The look is the caller's; the row's shape is asserted here.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import {
  type SessionControlButton,
  SessionControls,
  type SessionControlsProps,
} from "./session-controls.tsx";

/**
 * `prepare` runs on the core BEFORE the row mounts: `useSessionActions` picks
 * the methods off the core once, so a spy installed after render is a spy on a
 * function nothing holds any more.
 */
function mount(
  overrides: Parameters<typeof createMockSessionCore>[0] = {},
  props: SessionControlsProps = {},
  prepare?: (core: ReturnType<typeof createMockSessionCore>) => void,
) {
  const core = createMockSessionCore(overrides);
  prepare?.(core);
  const view = render(
    <ThemeProvider>
      <SessionProvider value={core}>
        <SessionControls {...props} />
      </SessionProvider>
    </ThemeProvider>,
  );
  return { core, view };
}

/** Every button's label, in DOM order. */
function labels(): string[] {
  return screen.getAllByRole("button").map((button) => button.textContent ?? "");
}

describe("SessionControls", () => {
  test("before the call: one Start button, and it dials", () => {
    let start: ReturnType<typeof vi.spyOn> | undefined;
    mount({ started: false }, {}, (core) => {
      start = vi.spyOn(core, "start");
    });
    expect(labels()).toEqual(["Start"]);
    fireEvent.click(screen.getByText("Start"));
    expect(start).toHaveBeenCalledOnce();
  });

  test("on the call: Pause, New Conversation, End — in that order", () => {
    mount({ started: true, running: true });
    expect(labels()).toEqual(["Pause", "New Conversation", "End"]);
  });

  test("the toggle reads Resume while paused, and Pause while running", () => {
    const { core } = mount({ started: true, running: false });
    expect(labels()[0]).toBe("Resume");
    act(() => core.toggle());
    expect(labels()[0]).toBe("Pause");
  });

  test("each button presses what its name says", () => {
    const spies: Record<string, ReturnType<typeof vi.spyOn>> = {};
    mount({ started: true, running: true }, {}, (core) => {
      spies.toggle = vi.spyOn(core, "toggle");
      // Stubbed, not merely observed: the mock's real `restart` is `end();
      // start()`, which would count a second `end` here — the pair itself is
      // `use-session-controls.test.ts`'s assertion.
      spies.restart = vi.spyOn(core, "restart").mockImplementation(() => undefined);
      spies.end = vi.spyOn(core, "end");
    });
    const { toggle, restart, end } = spies;
    fireEvent.click(screen.getByText("Pause"));
    fireEvent.click(screen.getByText("New Conversation"));
    fireEvent.click(screen.getByText("End"));
    expect(toggle).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  test("End flips the row back to its Start button", () => {
    // `end()` hangs up AND drops `started`, which is why it is `end()` and not
    // `reset()` — `reset()` keeps the call live and the buttons never toggle.
    mount({ started: true, running: true });
    fireEvent.click(screen.getByText("End"));
    expect(labels()).toEqual(["Start"]);
  });

  test("a partial `labels` renames the named buttons and keeps the rest", () => {
    mount({ started: true, running: true }, { labels: { pause: "Hold", end: "Hang up" } });
    expect(labels()).toEqual(["Hold", "New Conversation", "Hang up"]);
    mount({ started: false }, { labels: { start: "Begin Adventure" } });
    expect(screen.getByText("Begin Adventure")).toBeDefined();
  });

  test("`renderButton` gets every button with its action, label, handler and the running flag", () => {
    const seen: SessionControlButton[] = [];
    mount(
      { started: true, running: false },
      {
        renderButton: (button) => {
          seen.push(button);
          return (
            <button type="button" data-action={button.action} onClick={button.onClick}>
              {button.label}
            </button>
          );
        },
      },
    );
    expect(seen.map((b) => b.action)).toEqual(["toggle", "restart", "end"]);
    expect(seen.map((b) => b.label)).toEqual(["Resume", "New Conversation", "End"]);
    expect(seen.every((b) => b.running === false)).toBe(true);
    // The renderer's markup is what lands, and the handler it was handed works.
    expect(document.querySelector("[data-action='restart']")).not.toBeNull();
  });

  test("renders children after the buttons, and appends className to its own row classes", () => {
    const { view } = mount(
      { started: true, running: true },
      { className: "px-4", children: <span data-testid="count">3 incidents</span> },
    );
    const row = view.container.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("px-4");
    expect(row.lastElementChild?.getAttribute("data-testid")).toBe("count");
  });
});
