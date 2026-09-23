// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev`'s file watcher: which paths may trigger a restart, and the
 * debounced chokidar watch that asks for one. Split out of `_dev-server.ts`
 * (which kept the server wiring) when its injectable seams took that file
 * past the length cap.
 */

import path from "node:path";
import { watch } from "chokidar";
import pDebounce from "p-debounce";
import { notify } from "./_ui.ts";
import { errorCode, errorMessage } from "./_utils.ts";

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * True for paths that should never trigger a restart: anything inside
 * `node_modules/` and any dot-entry (`.git/`, `.aai/`, `.DS_Store`, …).
 * `.git/` especially matters — commits and status checks churn the index
 * and would otherwise cause spurious full backend restarts.
 *
 * Exception: `.env` / `.env.*` files stay watched — env edits should
 * restart the server with the new values.
 */
export function isIgnoredPath(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(path.sep).some((segment) => {
    if (segment === "node_modules") return true;
    if (segment === ".env" || segment.startsWith(".env.")) return false;
    return segment.startsWith(".");
  });
}

/** What the watch loop needs from a watcher. chokidar's `FSWatcher` satisfies it. */
export type DevWatcher = {
  on(event: "all", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  close(): Promise<void>;
};

/** chokidar's `watch`, narrowed to the one call shape {@link watchDirectory} makes. */
export type DevWatchFn = (
  dir: string,
  options: { ignored: (filePath: string) => boolean; ignoreInitial: boolean; persistent: boolean },
) => DevWatcher;

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts. Uses chokidar for reliable recursive
 * watching across platforms (raw `fs.watch` misses events on Linux).
 */
export function watchDirectory(
  dir: string,
  onChange: () => void,
  watchFn: DevWatchFn = watch,
): DevWatcher {
  const DEBOUNCE_MS = 300;

  const debouncedChange = pDebounce(() => {
    notify("info", "File change detected, restarting...");
    onChange();
  }, DEBOUNCE_MS);

  const watcher = watchFn(dir, {
    ignored: (filePath: string) => isIgnoredPath(dir, filePath),
    ignoreInitial: true,
    persistent: false,
  });
  // Without an 'error' listener an ENOSPC/EMFILE from the OS watcher would
  // either crash the process (unhandled 'error') or kill watching silently.
  watcher.on("error", (err: unknown) => {
    const hint =
      errorCode(err) === "ENOSPC"
        ? " The inotify watch limit was reached — raise the fs.inotify max_user_watches sysctl."
        : "";
    notify(
      "error",
      `File watcher error: ${errorMessage(err)}.${hint} ` +
        "Auto-restart on file changes may have stopped; restart `aai dev` after fixing.",
    );
  });
  watcher.on("all", () => {
    // debouncedChange resolves after onChange runs — a throw there must not
    // become an unhandled rejection that kills the dev server.
    debouncedChange().catch((err: unknown) => {
      notify("error", `Watch handler failed: ${errorMessage(err)}`);
    });
  });
  return watcher;
}
