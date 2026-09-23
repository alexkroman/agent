// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The top bar's dropdown chrome: absent while closed, a labelled dialog while
// open, and dismissed by Escape or a click away — but not by its own toggle.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DropdownPanel } from "./dropdown-panel.tsx";

function renderPanel(open: boolean) {
  const onClose = vi.fn();
  const result = render(
    <div>
      <button type="button" data-account-toggle="">
        Account
      </button>
      <button type="button">Elsewhere</button>
      <DropdownPanel
        id="account-panel"
        label="Account"
        open={open}
        onClose={onClose}
        toggleAttr="data-account-toggle"
      >
        <button type="button">Sign out</button>
      </DropdownPanel>
    </div>,
  );
  return { onClose, ...result };
}

describe("DropdownPanel", () => {
  test("renders nothing while closed", () => {
    renderPanel(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  test("open, it is a dialog named by its label and addressable by id", () => {
    renderPanel(true);
    const dialog = screen.getByRole("dialog", { name: "Account" });
    expect(dialog.id).toBe("account-panel");
    expect(dialog.textContent).toContain("Sign out");
  });

  test("Escape and a click away close it", () => {
    const { onClose } = renderPanel(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("a click inside, or on its toggle, does not", () => {
    const { onClose } = renderPanel(true);
    fireEvent.pointerDown(screen.getByText("Sign out"));
    fireEvent.pointerDown(screen.getByText("Account", { selector: "button" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
