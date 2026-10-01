// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio mode's preview server is the LOADED bundle's own, rebuilt per bundle.
 */

import type http from "node:http";
import { GUEST_HOST } from "@alexkroman1/aai-runtime/internal";
import { emptyHarnessState } from "aai-guest-core/bundle";
import type { CreateGuestRuntime, GuestHost } from "aai-guest-core/types";
import { describe, expect, test, vi } from "vitest";
import { warnOnSecondRuntime } from "./agent-mode.ts";
import { type PreviewServer, studioPreview } from "./studio-preview.ts";

/** A bundle factory carrying `host`, as the worker wrapper builds one. */
function bundle(host: GuestHost): CreateGuestRuntime {
  return Object.assign(
    () => ({ startSession: () => undefined, shutdown: () => Promise.resolve() }),
    { host },
  );
}

/** A built server the spec can recognise, and a builder that records whose host it used. */
function recordingBuilder() {
  const built: { host: GuestHost; server: PreviewServer; close: ReturnType<typeof vi.fn> }[] = [];
  const build = (host: GuestHost): PreviewServer => {
    const close = vi.fn(() => Promise.resolve());
    const server: PreviewServer = { node: {} as http.Server, close };
    built.push({ host, server, close });
    return server;
  };
  return { build, built };
}

describe("studioPreview", () => {
  test("serves nothing until a bundle is loaded", () => {
    expect(studioPreview(emptyHarnessState()).current()).toBeUndefined();
  });

  test("builds from the LOADED bundle's host once, and rebuilds for a new bundle", () => {
    const state = emptyHarnessState();
    const { build, built } = recordingBuilder();
    const preview = studioPreview(state, build);

    const firstHost = { ...GUEST_HOST };
    state.createRuntime = bundle(firstHost);
    state.host = firstHost;
    const a = preview.current();
    expect(preview.current()).toBe(a);
    expect(built.map((b) => b.host)).toEqual([firstHost]);

    // A second `test_agent` load replaces the bundle: the old server is closed
    // and the next request is served by a server the NEW bundle's host built.
    const secondHost = { ...GUEST_HOST };
    state.createRuntime = bundle(secondHost);
    state.host = secondHost;
    expect(preview.current()).toBe(built[1]?.server);
    expect(built[1]?.host).toBe(secondHost);
    expect(built[0]?.close).toHaveBeenCalledOnce();
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
