// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The channel a form's fields use to say "not ready yet" to the form.
 *
 * `useFormReadiness` is the form's half (an aggregate over keys) and
 * `useDeclareFieldsPending` the field's (one key per component, released on
 * unmount). Asserted through a small form that renders `pending`, so the
 * re-render a declaration causes is part of what is checked.
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import {
  FormReadinessProvider,
  useDeclareFieldsPending,
  useFormReadiness,
} from "./_form-readiness.ts";

function Shell({ children }: { children: ReactNode }) {
  const { pending, declare } = useFormReadiness();
  return (
    <FormReadinessProvider value={declare}>
      <output aria-label="pending">{String(pending)}</output>
      {children}
    </FormReadinessProvider>
  );
}

function Field({ pending }: { pending: boolean }) {
  useDeclareFieldsPending(pending);
  return null;
}

const pending = () => screen.getByLabelText("pending").textContent;

describe("useFormReadiness", () => {
  test("is pending while ANY key is held, and settles when the last lets go", () => {
    const { result } = renderHook(() => useFormReadiness());
    expect(result.current.pending).toBe(false);

    act(() => {
      result.current.declare("a", true);
      result.current.declare("b", true);
    });
    expect(result.current.pending).toBe(true);

    act(() => result.current.declare("a", false));
    expect(result.current.pending).toBe(true);
    act(() => result.current.declare("b", false));
    expect(result.current.pending).toBe(false);
  });

  test("a declaration that changes nothing is not a new state", () => {
    const { result } = renderHook(() => useFormReadiness());
    const declare = result.current.declare;
    act(() => declare("a", false));
    act(() => declare("a", true));
    act(() => declare("a", true));
    expect(result.current.pending).toBe(true);
    // Stable, so a field's effect does not re-run on every form render.
    expect(result.current.declare).toBe(declare);
  });
});

describe("useDeclareFieldsPending", () => {
  test("a pending field holds the form, and flipping it releases", () => {
    const { rerender } = render(
      <Shell>
        <Field pending />
      </Shell>,
    );
    expect(pending()).toBe("true");

    rerender(
      <Shell>
        <Field pending={false} />
      </Shell>,
    );
    expect(pending()).toBe("false");
  });

  test("each field is its own key, so one settling does not release another", () => {
    const { rerender } = render(
      <Shell>
        <Field pending />
        <Field pending />
      </Shell>,
    );
    rerender(
      <Shell>
        <Field pending={false} />
        <Field pending />
      </Shell>,
    );
    expect(pending()).toBe("true");
  });

  test("a field that unmounts while pending releases its hold", () => {
    const { rerender } = render(
      <Shell>
        <Field pending />
      </Shell>,
    );
    rerender(<Shell>{null}</Shell>);
    expect(pending()).toBe("false");
  });

  test("outside any form it is a no-op rather than a throw", () => {
    expect(() => render(<Field pending />)).not.toThrow();
  });
});
