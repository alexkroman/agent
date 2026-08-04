// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// useFileDraft is the one place user work can be lost: it decides when an
// agent's server-side edit replaces the buffer and when it must not.
// FileNav is the affordance that keeps large workspaces navigable: tabs for
// a handful of files, a directory-grouped sidebar past FILE_TAB_LIMIT.

import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FILE_TAB_LIMIT, FileNav, useFileDraft } from "./code-view.tsx";

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

describe("FileNav", () => {
  // No vitest globals in this package, so testing-library's auto-cleanup
  // never registers — without this each render accumulates in the DOM.
  afterEach(cleanup);
  test("renders tabs for a small workspace", () => {
    const onSelectFile = vi.fn();
    render(
      <FileNav
        paths={["agent.ts", "client.tsx"]}
        currentFile="agent.ts"
        onSelectFile={onSelectFile}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Workspace files" })).toBeDefined();
    const active = screen.getByRole("tab", { name: "agent.ts" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    screen.getByRole("tab", { name: "client.tsx" }).click();
    expect(onSelectFile).toHaveBeenCalledWith("client.tsx");
  });

  test("switches to a directory-grouped sidebar past FILE_TAB_LIMIT", () => {
    const onSelectFile = vi.fn();
    const paths = [
      "agent.ts",
      "seed.json",
      ...Array.from({ length: FILE_TAB_LIMIT }, (_, i) => `tools/tool_${i}.ts`),
    ];
    render(<FileNav paths={paths} currentFile="tools/tool_3.ts" onSelectFile={onSelectFile} />);
    // Sidebar, not tabs.
    expect(screen.queryByRole("tablist")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Workspace files" });
    // One directory header, entries shown by basename.
    expect(nav.textContent).toContain("tools/");
    const active = screen.getByRole("button", { name: "tool_3.ts" });
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(active.getAttribute("title")).toBe("tools/tool_3.ts");
    screen.getByRole("button", { name: "tool_1.ts" }).click();
    expect(onSelectFile).toHaveBeenCalledWith("tools/tool_1.ts");
  });

  test("sidebar lists root files before directories", () => {
    const paths = [
      ...Array.from({ length: FILE_TAB_LIMIT }, (_, i) => `tools/tool_${i}.ts`),
      "agent.ts",
    ].sort();
    render(<FileNav paths={paths} currentFile={null} onSelectFile={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.textContent).toBe("agent.ts");
  });
});
