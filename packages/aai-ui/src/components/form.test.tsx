// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The `<Form>` shell: one submission at a time, the caller's error, and a
 * pending `SubmitButton`.
 *
 * WHAT a submission carries is `_form-values.test.tsx`'s subject (the value
 * each control contributes) and `form-fields.test.tsx`'s (the file fields).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { Form, SubmitButton } from "./form.tsx";

describe("submitting", () => {
  test("cannot be submitted twice while the first is still in flight", async () => {
    // A workflow run is expensive and not idempotent; a double-click must not
    // start two.
    const { promise, resolve } = Promise.withResolvers<void>();
    const onSubmit = vi.fn(() => promise);
    render(
      <ThemeProvider>
        <Form onSubmit={onSubmit}>
          <SubmitButton>Go</SubmitButton>
        </Form>
      </ThemeProvider>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolve();
  });

  test("shows the caller's error, since the interesting ones are the server's", () => {
    render(
      <ThemeProvider>
        <Form onSubmit={vi.fn()} error="agent unavailable, retry shortly" />
      </ThemeProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("agent unavailable");
  });

  test("a pending SubmitButton is disabled and says what it is doing", () => {
    render(
      <ThemeProvider>
        <Form onSubmit={vi.fn()}>
          <SubmitButton pending>Transcribe</SubmitButton>
        </Form>
      </ThemeProvider>,
    );
    // Pending is the WORK, not the submit: a run outlives its POST, so the
    // button stays busy until the run is done.
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Working…");
  });
});
