// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio mode's preview server is the LOADED bundle's own, rebuilt per bundle.
 */

import { emptyHarnessState } from "aai-guest-core/bundle";
import type { CreateGuestRuntime, GuestHost } from "aai-guest-core/types";
import { describe, expect, test, vi } from "vitest";
import { warnOnSecondRuntime } from "./agent-mode.ts";
import { studioPreview } from "./studio-preview.ts";

/** A factory whose host builds a recognisable fake server. */
function factoryWithHost(label: string) {
  const close = vi.fn(() => Promise.resolve());
  const createRuntimeServer = vi.fn(() => ({ node: { label }, close }));
  const factory = Object.assign(
    () => ({ startSession: () => undefined, shutdown: () => Promise.resolve() }),
    { host: { version: 1, createRuntimeServer } as unknown as GuestHost },
  ) as CreateGuestRuntime;
  return { factory, createRuntimeServer, close };
}

describe("studioPreview", () => {
  test("serves nothing until a bundle is loaded", () => {
    expect(studioPreview(emptyHarnessState()).current()).toBeUndefined();
  });

  test("builds the server from the bundle's host once, and rebuilds for a new bundle", () => {
    const state = emptyHarnessState();
    const preview = studioPreview(state);
    const first = factoryWithHost("first");
    state.createRuntime = first.factory;
    state.host = first.factory.host;

    const a = preview.current();
    expect(preview.current()).toBe(a);
    expect(first.createRuntimeServer).toHaveBeenCalledOnce();
    expect(a?.node).toEqual({ label: "first" });

    // A second `test_agent` load replaces the bundle: the old server is closed
    // and the next request is served by the new bundle's runtime.
    const second = factoryWithHost("second");
    state.createRuntime = second.factory;
    state.host = second.factory.host;
    expect(preview.current()?.node).toEqual({ label: "second" });
    expect(first.close).toHaveBeenCalledOnce();
  });
});

describe("warnOnSecondRuntime", () => {
  test("one runtime copy is the healthy guest; two are reported", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(warnOnSecondRuntime(["file:///opt/aai/bundle.mjs"])).toBe(false);
    expect(warnOnSecondRuntime(["file:///opt/aai/bundle.mjs", "file:///opt/aai/x.js"])).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("2 copies"));
    error.mockRestore();
  });
});
