// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// useFileDraft is the one place user work can be lost: it decides when an
// agent's server-side edit replaces the buffer and when it must not.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useFileDraft } from "./code-view.tsx";

describe("useFileDraft", () => {
  test("adopts server updates while the buffer is clean", () => {
    const { result, rerender } = renderHook(({ server }) => useFileDraft(server), {
      initialProps: { server: "v1" },
    });
    rerender({ server: "v2" });
    expect(result.current.draft).toBe("v2");
    expect(result.current.dirty).toBe(false);
    expect(result.current.conflict).toBe(false);
  });

  test("keeps unsaved edits when the server changes, and flags the conflict", () => {
    const { result, rerender } = renderHook(({ server }) => useFileDraft(server), {
      initialProps: { server: "v1" },
    });
    act(() => result.current.edit("my edit"));
    rerender({ server: "agent edit" });
    // The user's work survives; the overwrite risk is surfaced, not silent.
    expect(result.current.draft).toBe("my edit");
    expect(result.current.dirty).toBe(true);
    expect(result.current.conflict).toBe(true);
  });

  test("saving clears dirty and conflict without reverting the buffer", () => {
    const { result, rerender } = renderHook(({ server }) => useFileDraft(server), {
      initialProps: { server: "v1" },
    });
    act(() => result.current.edit("my edit"));
    rerender({ server: "agent edit" });
    act(() => result.current.markSaved());
    expect(result.current.dirty).toBe(false);
    expect(result.current.conflict).toBe(false);
    // The server prop is still stale (refetch pending) — the just-saved
    // draft must not be clobbered by the old content.
    expect(result.current.draft).toBe("my edit");
    // Once the refetch lands the saved content, adoption is a no-op.
    rerender({ server: "my edit" });
    expect(result.current.draft).toBe("my edit");
    expect(result.current.conflict).toBe(false);
  });

  test("a clean buffer never reports a conflict", () => {
    const { result, rerender } = renderHook(({ server }) => useFileDraft(server), {
      initialProps: { server: "v1" },
    });
    rerender({ server: "v2" });
    rerender({ server: "v3" });
    expect(result.current.conflict).toBe(false);
    expect(result.current.draft).toBe("v3");
  });
});
