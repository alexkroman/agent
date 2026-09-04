// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopy } from "./use-copy.ts";

/**
 * jsdom ships no `navigator.clipboard`, which is also the shape of the failure
 * this hook exists to report — so every test defines the clipboard it wants.
 */
function installClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  installClipboard(undefined);
});

describe("useCopy", () => {
  it("writes the text and flashes the button that owns it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    installClipboard(writeText);
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      result.current.copy("wss://agent.example/websocket");
    });

    expect(writeText).toHaveBeenCalledWith("wss://agent.example/websocket");
    expect(result.current.label("wss://agent.example/websocket")).toBe("Copied");
    expect(result.current.didCopy("wss://agent.example/websocket")).toBe(true);
  });

  /*
   * The bug the shared hook fixes. The hand-rolled copy inside `url-chips.tsx`
   * ended `.catch(() => {})`, so on an insecure context or a denied permission
   * the button changed NOTHING — indistinguishable from a broken page.
   */
  it("reports a REJECTED write instead of swallowing it", async () => {
    installClipboard(() => Promise.reject(new Error("denied")));
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      result.current.copy("secret");
    });

    expect(result.current.label("secret")).toBe("Failed");
    expect(result.current.didCopy("secret")).toBe(false);
  });

  it("reports an ABSENT clipboard the same way", () => {
    installClipboard(undefined);
    const { result } = renderHook(() => useCopy());

    act(() => result.current.copy("secret"));

    expect(result.current.label("secret")).toBe("Failed");
    expect(result.current.didCopy("secret")).toBe(false);
  });

  /*
   * Keying by TEXT is what makes a list of URLs readable: two rows both
   * claiming to be on the clipboard is a lie about one of them.
   */
  it("flashes only the row that was clicked", async () => {
    installClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      result.current.copy("first");
    });

    expect(result.current.label("first")).toBe("Copied");
    expect(result.current.label("second")).toBe("Copy");

    await act(async () => {
      result.current.copy("second");
    });

    expect(result.current.label("first"), "the first row kept its Copied").toBe("Copy");
    expect(result.current.label("second")).toBe("Copied");
  });

  it("takes the caller's own idle word, and overrides it only while flashing", async () => {
    installClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopy());

    expect(result.current.label("https://agent.example/", "UI")).toBe("UI");

    await act(async () => {
      result.current.copy("https://agent.example/");
    });

    expect(result.current.label("https://agent.example/", "UI")).toBe("Copied");
  });

  it("returns to its idle label once the flash elapses", async () => {
    installClipboard(() => Promise.resolve());
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      result.current.copy("done");
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(result.current.label("done")).toBe("Copy");
    expect(result.current.didCopy("done")).toBe(false);
  });
});
