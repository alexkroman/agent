// Copyright 2026 the AAI authors. MIT license.
/**
 * Recovery for the one failure a deploy guarantees: a tab holding a build
 * that no longer exists on the server.
 *
 * Vite emits content-hashed chunks and the server serves them `immutable`,
 * so a chunk's URL is only valid for as long as the container image that
 * contains it is running. A Modal deploy replaces that image. Two windows
 * follow, and only the first is a race:
 *
 * - **During the rollout**, the default rolling strategy keeps old
 *   containers serving beside new ones (up to `scaledown_window`, 300s), and
 *   Modal load-balances every request independently — so a shell fetched
 *   from one build can have its assets answered by the other. `no-store` on
 *   the shell (`aai-studio-server/studio-static.ts`) keeps this to the
 *   in-flight navigation rather than a browser pinned to a dead build.
 * - **After the rollout**, every tab opened before it is holding stale chunk
 *   URLs, with no race at all. This is the common case: the studio is a
 *   long-lived SPA, `CodeView` is lazily imported (CodeMirror is the bulk of
 *   the bundle), and nothing loads it until the user clicks the Code tab —
 *   which may be hours after the deploy that deleted its chunk.
 *
 * Untreated, that second case is a dead tab: React's `lazy` throws, and with
 * no boundary the whole tree unmounts to a blank page. The fix is the same
 * one the user would reach for — reload — done automatically and exactly
 * once, since the reload picks up the current shell and with it the current
 * chunk names.
 *
 * "Exactly once" is the load-bearing part. A chunk can also fail to load for
 * reasons a reload cannot fix (an offline tab, a proxy eating the request, a
 * genuinely broken deploy), and an unguarded reload-on-failure is a reload
 * loop that never renders long enough to say what went wrong. The guard is
 * therefore in `sessionStorage`: per-tab, so one tab's recovery does not
 * suppress another's, and cleared when the tab closes, so a stale marker
 * cannot disarm the recovery weeks later.
 */

/** Per-tab marker: the timestamp of the last stale-build reload we forced. */
const RELOAD_MARKER = "aai:stale-build-reload";

/**
 * How long a reload marker suppresses another one. Long enough that a
 * reload-loop cannot form (a failing tab settles into showing its error
 * instead), short enough that a tab left open across two deploys can still
 * recover from the second.
 */
const RELOAD_COOLDOWN_MS = 60_000;

/** Session storage, or `null` where it is unavailable (Safari private mode throws). */
function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Force one reload to pick up the current build, unless we just did.
 *
 * Returns whether the reload was actually triggered — callers use it to
 * decide between "the page is navigating away, render nothing more" and
 * "recovery is exhausted, surface the failure".
 */
export function reloadForStaleBuild(now: number = Date.now()): boolean {
  const storage = safeSessionStorage();
  // No store means no loop guard. Declining costs an unrecoverable tab in a
  // browser that has already opted out of session storage; reloading anyway
  // costs an unbounded reload loop in exactly the tabs least able to report
  // one — so the write, not the reload, is what this gates on.
  if (!storage) return false;
  const previous = Number(storage.getItem(RELOAD_MARKER) ?? Number.NaN);
  // A marker from the future (a clock step) must not disarm recovery forever.
  if (Number.isFinite(previous) && now - previous >= 0 && now - previous < RELOAD_COOLDOWN_MS) {
    return false;
  }
  try {
    storage.setItem(RELOAD_MARKER, String(now));
  } catch {
    return false;
  }
  globalThis.location?.reload();
  return true;
}

/**
 * `React.lazy` factory wrapper that survives a deploy.
 *
 * One retry first: a chunk fetch can also fail transiently (a dropped
 * connection mid-navigation), and reloading the whole app is a heavier
 * answer than asking again. Only when the retry fails too do we treat it as
 * a build that is gone.
 *
 * On a triggered reload the returned promise never settles — deliberately.
 * The page is already navigating away, and resolving or rejecting would
 * flash an error boundary over a document about to be replaced; leaving it
 * pending keeps React on the Suspense fallback for the ~instant it has left.
 * When no reload is available the second failure is rethrown, so the fault
 * reaches React rather than hanging the tab on that same fallback forever.
 */
export function lazyRetry<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await factory();
    } catch {
      try {
        return await factory();
      } catch (err) {
        if (reloadForStaleBuild()) {
          return new Promise<T>(() => {
            // Never settles: the reload above is already replacing this
            // document, and settling would flash a failure state over it.
          });
        }
        // Recovery is exhausted, so the failure has to reach React — a Code
        // tab left hanging on its Suspense fallback explains nothing.
        throw err;
      }
    }
  };
}

/**
 * Vite's own signal for the same fault, on the path that never reaches
 * `lazyRetry`: `<link rel="modulepreload">` for a chunk the server no longer
 * has fails at preload time, before any import statement runs. Vite fires a
 * cancelable `vite:preloadError` for it, and left unhandled the default is to
 * throw — so this is the difference between a recovered tab and an uncaught
 * error in the console.
 *
 * Returns a teardown so tests (and any future remount) can unregister.
 */
export function installStaleBuildRecovery(target: EventTarget = globalThis): () => void {
  const onPreloadError = (event: Event) => {
    // Claim the failure before reloading: unprevented, Vite rethrows it.
    event.preventDefault();
    reloadForStaleBuild();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}
