// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `<ConsoleShell>` was `@internal`, so a client that wanted its own
 * conversation markup had to rebuild the chrome as well — and every one that
 * did re-derived the error banner WITHOUT `role="alert"`. That is the one part
 * of this component a reviewer cannot see is missing, so it is the one this
 * spec is mostly about.
 *
 * The banner is `<SessionErrorBanner>` now, and this file asserts the
 * COMPOSITION rather than re-asserting that component's own contract: that the
 * shell still announces an error it was never handed, from a session it reads
 * itself. `session-error-banner.test.tsx` owns the banner's own rules. The
 * split matters because the failure this guards is a shell that quietly stops
 * rendering the banner — which looks like a healthy page.
 */

import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider } from "../context.ts";
import type { SessionError } from "../types.ts";
import { ConsoleShell } from "./console-shell.tsx";

function shell(
  props: Partial<Parameters<typeof ConsoleShell>[0]> = {},
  error: SessionError | null = null,
) {
  const core = createMockSessionCore({ error });
  const tree: ReactNode = (
    <ConsoleShell
      state="ready"
      pulsing={false}
      footer={<button type="button">Stop</button>}
      {...props}
    >
      <p>Conversation</p>
    </ConsoleShell>
  );
  return render(createElement(SessionProvider, { value: core }, tree));
}

describe("ConsoleShell", () => {
  test("announces its error banner, which is the reason it is published", () => {
    // Per the `fatalError` latch in `session-core.ts` the banner is the ONLY
    // remaining signal — the state eyebrow beside it goes back to reading like
    // a live session — so an unannounced banner is a session that failed
    // silently for a screen reader.
    shell({}, { code: "audio", message: "microphone permission denied" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("microphone permission denied (audio)");
  });

  test("shows no banner when there is no error", () => {
    shell();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("renders the content and the footer, and the title when given one", () => {
    shell({ title: "Dispatch" });
    expect(screen.getByText("Conversation")).not.toBeNull();
    expect(screen.getByText("Stop")).not.toBeNull();
    expect(screen.getByText("Dispatch")).not.toBeNull();
  });

  test("shows the live state, and a custom icon in place of the logo", () => {
    const { container } = shell({
      state: "thinking",
      icon: <span data-testid="mark">*</span>,
    });
    expect(screen.getByText("thinking")).not.toBeNull();
    expect(container.querySelector("[data-testid='mark']")).not.toBeNull();
    // The stock logo is an <svg>; a custom icon replaces it rather than joining
    // it, which is what a branded chrome needs.
    expect(container.querySelector("svg")).toBeNull();
  });

  test("appends className rather than replacing the shell's own layout classes", () => {
    const { container } = shell({ className: "ring-2" });
    const root = container.firstElementChild;
    expect(root?.className).toContain("ring-2");
    expect(root?.className).toContain("flex");
  });
});
