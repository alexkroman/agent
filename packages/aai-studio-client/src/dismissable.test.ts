// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Escape / click-away dismissal. The toggle's exemption is the load-bearing
// part: without it, pressing a pressed toggle closes and then reopens the panel.

import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDismissablePanel } from "./dismissable.ts";

let panelEl: HTMLDivElement;
let inside: HTMLButtonElement;
let toggle: HTMLButtonElement;
let toggleIcon: HTMLSpanElement;
let outside: HTMLButtonElement;

beforeEach(() => {
  panelEl = document.createElement("div");
  inside = document.createElement("button");
  panelEl.append(inside);
  toggle = document.createElement("button");
  toggle.setAttribute("data-publish-toggle", "");
  toggleIcon = document.createElement("span");
  toggle.append(toggleIcon);
  outside = document.createElement("button");
  document.body.append(panelEl, toggle, outside);
});

afterEach(() => {
  document.body.replaceChildren();
});

function mount(open = true) {
  const onClose = vi.fn();
  const panel = { current: panelEl };
  const hook = renderHook(
    ({ open, onClose }: { open: boolean; onClose: () => void }) =>
      useDismissablePanel({ open, onClose, panel, toggleAttr: "data-publish-toggle" }),
    { initialProps: { open, onClose } },
  );
  return { onClose, ...hook };
}

describe("useDismissablePanel", () => {
  test("Escape closes", () => {
    const { onClose } = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("other keys do not", () => {
    const { onClose } = mount();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a pointerdown outside closes", () => {
    const { onClose } = mount();
    fireEvent.pointerDown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a pointerdown inside the panel does not", () => {
    const { onClose } = mount();
    fireEvent.pointerDown(inside);
    fireEvent.pointerDown(panelEl);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the toggle — and anything inside it — exempts itself", () => {
    const { onClose } = mount();
    fireEvent.pointerDown(toggle);
    fireEvent.pointerDown(toggleIcon);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a closed panel listens to nothing", () => {
    const { onClose } = mount(false);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(outside);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("closing the panel removes both listeners", () => {
    const { onClose, rerender } = mount(true);
    rerender({ open: false, onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(outside);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a new inline onClose each render does NOT re-install the listeners, and the latest is called", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { onClose: first, rerender } = mount(true);
    const installs = add.mock.calls.length;
    const latest = vi.fn();
    rerender({ open: true, onClose: latest });
    rerender({ open: true, onClose: latest });
    expect(add.mock.calls.length).toBe(installs);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    add.mockRestore();
  });
});
