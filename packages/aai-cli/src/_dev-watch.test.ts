// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev`'s watcher, through its `watchFn` seam — no module mocks. A fake
 * watcher records the options it was opened with and the listeners attached,
 * so each test drives an event by hand.
 */

import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type DevWatchFn, isIgnoredPath, watchDirectory } from "./_dev-watch.ts";
import { log } from "./_ui.ts";

type Listeners = { all?: () => void; error?: (err: unknown) => void };

function fakeWatch() {
  const listeners: Listeners = {};
  let options: Parameters<DevWatchFn>[1] | undefined;
  const watchFn: DevWatchFn = (_dir, opts) => {
    options = opts;
    return {
      on(event: "all" | "error", listener: never) {
        listeners[event] = listener;
        return this;
      },
      close: () => Promise.resolve(),
    };
  };
  return { watchFn, listeners, options: () => options };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isIgnoredPath", () => {
  const dir = path.join(path.sep, "proj");
  const at = (...parts: string[]) => path.join(dir, ...parts);

  test("ignores node_modules and dot-entries anywhere under the root", () => {
    expect(isIgnoredPath(dir, at("node_modules", "pkg", "index.js"))).toBe(true);
    expect(isIgnoredPath(dir, at(".aai", "cache"))).toBe(true);
    expect(isIgnoredPath(dir, at(".git", "index.lock"))).toBe(true);
    expect(isIgnoredPath(dir, at("sub", ".hidden", "file.ts"))).toBe(true);
  });

  test("keeps source files and .env files watched", () => {
    expect(isIgnoredPath(dir, at("agent.ts"))).toBe(false);
    expect(isIgnoredPath(dir, at("tools", "search.ts"))).toBe(false);
    expect(isIgnoredPath(dir, at(".env"))).toBe(false);
    expect(isIgnoredPath(dir, at(".env.local"))).toBe(false);
  });

  test("never ignores the root itself or a path outside it", () => {
    expect(isIgnoredPath(dir, dir)).toBe(false);
    expect(isIgnoredPath(dir, path.join(path.sep, "elsewhere", ".git"))).toBe(false);
  });
});

describe("watchDirectory", () => {
  test("opens the watcher with the ignore matcher, non-persistent, no initial scan", () => {
    const fake = fakeWatch();
    watchDirectory("/tmp/watched", () => undefined, fake.watchFn);
    const opts = fake.options();
    expect(opts).toMatchObject({ ignoreInitial: true, persistent: false });
    expect(opts?.ignored(path.join("/tmp/watched", ".git", "HEAD"))).toBe(true);
    expect(opts?.ignored(path.join("/tmp/watched", "agent.ts"))).toBe(false);
  });

  test("logs watcher errors, with an inotify hint for ENOSPC", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const fake = fakeWatch();
    watchDirectory("/tmp/watched", () => undefined, fake.watchFn);

    fake.listeners.error?.(Object.assign(new Error("watch limit"), { code: "ENOSPC" }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("max_user_watches"));

    fake.listeners.error?.(new Error("disk gone"));
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("disk gone"));
    expect(error).toHaveBeenLastCalledWith(expect.not.stringContaining("max_user_watches"));
  });

  test("a throwing onChange is logged, not an unhandled rejection", async () => {
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const fake = fakeWatch();
    watchDirectory(
      "/tmp/watched",
      () => {
        throw new Error("restart exploded");
      },
      fake.watchFn,
    );
    fake.listeners.all?.();
    // The debounce window is 300ms; the throw surfaces via the catch handler.
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining("restart exploded")),
    );
  });
});
