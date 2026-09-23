// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The shared send affordance: Enter submits unless Shift is held or an IME
// candidate is being confirmed, and the button is a labelled, disableable
// icon button.

import { fireEvent, render, screen } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { describe, expect, test, vi } from "vitest";
import { button } from "../_test-utils.ts";
import { isEnterSubmit, SEND_BUTTON_CLASS, SendButton } from "./send-button.tsx";

/** Capture what React hands a real `onKeyDown` for this keydown. */
function keyDown(init: KeyboardEventInit & { isComposing?: boolean }): boolean {
  let verdict: boolean | undefined;
  const { unmount } = render(
    <input
      aria-label="field"
      onKeyDown={(e: KeyboardEvent) => {
        verdict = isEnterSubmit(e);
      }}
    />,
  );
  fireEvent.keyDown(screen.getByLabelText("field"), init);
  unmount();
  if (verdict === undefined) throw new Error("onKeyDown did not fire");
  return verdict;
}

describe("isEnterSubmit", () => {
  test("a plain Enter submits", () => {
    expect(keyDown({ key: "Enter" })).toBe(true);
  });

  test("Shift+Enter is the newline escape", () => {
    expect(keyDown({ key: "Enter", shiftKey: true })).toBe(false);
  });

  test("Enter confirming an IME candidate does not submit", () => {
    expect(keyDown({ key: "Enter", isComposing: true })).toBe(false);
  });

  test("any other key does not submit", () => {
    expect(keyDown({ key: "a" })).toBe(false);
    expect(keyDown({ key: "Tab" })).toBe(false);
  });
});

describe("SendButton", () => {
  test("is a labelled button carrying the shared shell and the caller's size", () => {
    render(<SendButton onClick={() => undefined} disabled={false} className="h-9 w-9" />);
    const send = button("Send");
    expect(send.type).toBe("button");
    expect(send.className).toContain("h-9 w-9");
    expect(send.className).toContain(SEND_BUTTON_CLASS);
    expect(send.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("clicks through when enabled", () => {
    const onClick = vi.fn();
    render(<SendButton onClick={onClick} disabled={false} className="" />);
    fireEvent.click(button("Send"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a disabled button does not fire", () => {
    const onClick = vi.fn();
    render(<SendButton onClick={onClick} disabled className="" />);
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
