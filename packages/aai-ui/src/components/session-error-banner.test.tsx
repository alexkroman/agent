// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The banner's whole reason for existing is a pair of things a reviewer cannot
 * see are missing: the `role="alert"` (per the `fatalError` latch in
 * `session-core.ts` this banner is the only remaining signal a session died)
 * and the error CODE (the three chromes that hand-rolled it had already drifted
 * on whether to print it — one dropped it entirely). Both are asserted here,
 * plus that it reads the session rather than a prop, which is what makes them
 * un-droppable at a call site.
 */

import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider } from "../context.ts";
import type { SessionError } from "../types.ts";
import { SessionErrorBanner } from "./session-error-banner.tsx";

function mount(error: SessionError | null = null, className?: string) {
  const core = createMockSessionCore({ error });
  const view = render(
    <SessionProvider value={core}>
      <SessionErrorBanner className={className} />
    </SessionProvider>,
  );
  return { core, view };
}

describe("SessionErrorBanner", () => {
  test("announces the error, and prints its CODE beside the message", () => {
    // The code is the eight-member wire union — the stable half of an error and
    // the half a user can quote. One template's banner dropped it.
    mount({ code: "connection", message: "the session ended", fatal: false });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("the session ended (connection)");
  });

  test("renders nothing at all when the session is fine", () => {
    const { view } = mount();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.container.firstElementChild).toBeNull();
  });

  test("reads the session itself, so an error appearing LATER shows up", () => {
    // The prop-taking version of this component is one a caller can forget to
    // wire; subscribing is what makes that unrepresentable.
    const { core } = mount();
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      core.update({ error: { code: "stt", message: "transcriber refused", fatal: true } });
    });
    expect(screen.getByRole("alert").textContent).toBe("transcriber refused (stt)");
  });

  test("appends className rather than replacing its own classes", () => {
    // A full-bleed chrome places this in a grid; it must be able to say where
    // without losing the padding and the colour that make it a banner.
    mount({ code: "internal", message: "boom", fatal: true }, "col-span-2");
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("col-span-2");
    expect(alert.className).toContain("rounded-aai");
  });
});
