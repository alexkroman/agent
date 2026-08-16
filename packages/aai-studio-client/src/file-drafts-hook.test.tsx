// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The half of file-drafts.ts that needs React: that the buffers OUTLIVE the
// editor, which is the bug — `CodeView` is unmounted by the pane switcher and
// `FileBuffer` is remounted by every file switch, and both used to take the
// unsaved text with them. Plus the beforeunload guard, which is the only thing
// covering a reload.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { bufferFor, useFileDrafts } from "./file-drafts.ts";

// Every render is unmounted by the package setup file's `afterEach(cleanup)`,
// which is what keeps one test's `beforeunload` listener from still being
// installed when the next one asks whether anything is dirty.
describe("useFileDrafts", () => {
  test("an edit survives switching files and coming back", () => {
    const files = { "agent.ts": "server agent", "tools/a.ts": "server tool" };
    const { result } = renderHook(() => useFileDrafts(files));

    act(() => result.current.edit("agent.ts", "my agent edit"));
    // Selecting another file used to remount the buffer with `key={path}`,
    // which is where the edit went.
    expect(bufferFor(result.current.buffers, "tools/a.ts", files).draft).toBe("server tool");
    expect(bufferFor(result.current.buffers, "agent.ts", files).draft).toBe("my agent edit");
    expect(bufferFor(result.current.buffers, "agent.ts", files).dirty).toBe(true);
  });

  test("adopts the agent's edit while clean, and reports a conflict once dirty", () => {
    const { result, rerender } = renderHook(({ files }) => useFileDrafts(files), {
      initialProps: { files: { "agent.ts": "v1" } },
    });
    rerender({ files: { "agent.ts": "v2" } });
    expect(bufferFor(result.current.buffers, "agent.ts", { "agent.ts": "v2" }).draft).toBe("v2");

    act(() => result.current.edit("agent.ts", "mine"));
    rerender({ files: { "agent.ts": "v3" } });
    const buffer = bufferFor(result.current.buffers, "agent.ts", { "agent.ts": "v3" });
    expect(buffer.draft).toBe("mine");
    expect(buffer.conflict).toBe(true);
  });

  test("markSaved clears dirty and conflict without reverting the buffer", () => {
    const { result, rerender } = renderHook(({ files }) => useFileDrafts(files), {
      initialProps: { files: { "agent.ts": "v1" } },
    });
    act(() => result.current.edit("agent.ts", "mine"));
    rerender({ files: { "agent.ts": "agent edit" } });
    act(() => result.current.markSaved("agent.ts"));

    const buffer = bufferFor(result.current.buffers, "agent.ts", { "agent.ts": "agent edit" });
    expect(buffer.dirty).toBe(false);
    expect(buffer.conflict).toBe(false);
    // The refetch has not landed yet — the just-saved draft must not be
    // clobbered by the content it replaced.
    expect(buffer.draft).toBe("mine");
  });

  test("markSaved on a file with no buffer is a no-op", () => {
    const { result } = renderHook(() => useFileDrafts({ "agent.ts": "v1" }));
    const before = result.current.buffers;
    act(() => result.current.markSaved("agent.ts"));
    expect(result.current.buffers).toBe(before);
  });

  test("typing again does not clear a conflict already raised", () => {
    const { result, rerender } = renderHook(({ files }) => useFileDrafts(files), {
      initialProps: { files: { "agent.ts": "v1" } },
    });
    act(() => result.current.edit("agent.ts", "mine"));
    rerender({ files: { "agent.ts": "agent edit" } });
    act(() => result.current.edit("agent.ts", "mine, more"));
    expect(
      bufferFor(result.current.buffers, "agent.ts", { "agent.ts": "agent edit" }).conflict,
    ).toBe(true);
  });

  test("a dirty buffer arms beforeunload, and a saved one disarms it", () => {
    const { result } = renderHook(() => useFileDrafts({ "agent.ts": "v1" }));
    expect(dispatchBeforeUnload()).toBe(false);

    act(() => result.current.edit("agent.ts", "mine"));
    expect(dispatchBeforeUnload()).toBe(true);

    act(() => result.current.markSaved("agent.ts"));
    expect(dispatchBeforeUnload()).toBe(false);
  });
});

/** Did anything ask the browser to confirm leaving? */
function dispatchBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
