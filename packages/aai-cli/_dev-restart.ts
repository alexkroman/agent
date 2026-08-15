// Copyright 2026 the AAI authors. MIT license.
/**
 * Restart supervision for `aai dev`.
 *
 * The dev server's subtlest logic is not the wiring (chokidar, Vite, the
 * bundler) but the small state machine that decides WHEN to rebuild and in
 * what order to swap servers: an edit saved mid-boot must be queued rather
 * than race the initial build, a failed build must leave the old server
 * serving, a `listen` that loses the port race must retry, and teardown must
 * be idempotent and win every race against an in-flight rebuild.
 *
 * That machine lives here, behind injected `build`/`listen`/`close`
 * operations, so it can be exercised directly — no file watcher, no bundler,
 * no debounce, no module mocks. `_dev-server.ts` supplies the real operations.
 *
 * The supervised server is opaque (`S`): the supervisor never touches it
 * except through `ops`, so a test can use a plain label.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { errorMessage } from "./_utils.ts";

/** Attempts to bind the port during the close→listen swap. */
const LISTEN_ATTEMPTS = 3;
/** Backoff between those attempts. */
const LISTEN_RETRY_DELAY_MS = 250;

export type NotifyLevel = "error" | "warn" | "info" | "success";

export type RestartOps<S> = {
  /** Build a replacement server. Rejections leave the current one serving. */
  build(): Promise<S>;
  /** Bind the port. Rejections are retried — see {@link LISTEN_ATTEMPTS}. */
  listen(server: S): Promise<void>;
  /** Release the port and any per-server resources. */
  close(server: S): Promise<void>;
  /** User-facing progress and failures. */
  notify(level: NotifyLevel, message: string): void;
  /**
   * Extra teardown (file watcher, Vite) run once by {@link
   * RestartSupervisor.close}, before the current server closes. Failures are
   * swallowed so one leak can't strand the others.
   */
  teardown?: () => Promise<void>;
  /**
   * Injectable so retry specs need neither wall-clock nor fake timers. The
   * default is the repo's one `sleep`, which virtual time CAN drive — this seam
   * predates it and existed because `node:timers/promises` cannot be driven at
   * all (see `aai/sdk/sleep.ts`).
   */
  sleep?: (ms: number) => Promise<void>;
};

export type RestartSupervisor<S> = {
  /**
   * A change was detected. Queues instead of racing when a restart (or the
   * initial boot) is still in flight.
   */
  request(): void;
  /**
   * Startup finished with `server`. Releases the queue and runs the one
   * restart an edit saved during boot asked for.
   */
  adopt(server: S): void;
  /** The server currently serving, or `undefined` before {@link adopt}. */
  current(): S | undefined;
  /** Idempotent teardown. Concurrent callers join the in-flight run. */
  close(): Promise<void>;
};

/**
 * Create a {@link RestartSupervisor}. It starts in the "restarting" state:
 * callers install their watcher and call {@link RestartSupervisor.request}
 * freely while the initial build runs, then {@link RestartSupervisor.adopt}
 * the built server (or {@link RestartSupervisor.close} on startup failure).
 */
export function createRestartSupervisor<S>(ops: RestartOps<S>): RestartSupervisor<S> {
  const wait = ops.sleep ?? sleep;
  // Starts true: startup counts as an in-flight "restart", so a change event
  // landing during the multi-second boot queues instead of racing the build.
  let restarting = true;
  let pendingRestart = false;
  let closed = false;
  let current: S | undefined;
  let cleanupPromise: Promise<void> | undefined;

  function request(): void {
    // A change during an in-flight restart must not be dropped: flag it so
    // restart() loops once more with the newest files. Otherwise the final
    // save is silently ignored (stale server), or — if the in-flight restart
    // failed on a mid-edit syntax error — the server stays down entirely.
    if (restarting) {
      pendingRestart = true;
      return;
    }
    restarting = true;
    // restart() catches its own build/listen failures, but a throw from an
    // unexpected path must still be logged and must still clear `restarting`
    // (catch-then-finally = try/finally semantics), or watching wedges forever.
    void restart()
      .catch((err: unknown) => {
        ops.notify("error", `Restart failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        restarting = false;
      });
  }

  async function restart(): Promise<void> {
    do {
      pendingRestart = false;
      await restartOnce();
    } while (pendingRestart && !closed);
  }

  async function restartOnce(): Promise<void> {
    // Build the replacement server FIRST (the slow part — full bundle +
    // runtime construction). The old server keeps serving live sessions the
    // whole time, and a failed build (e.g. a mid-edit syntax error) leaves it
    // running instead of leaving the port dead until the next save.
    let newServer: S;
    try {
      newServer = await ops.build();
    } catch (err) {
      ops.notify("error", `Restart failed: ${errorMessage(err)} (previous server still running)`);
      return;
    }
    // close() may have run while we were rebuilding — don't leave a freshly
    // built server orphaned (leaked port / hung event loop).
    if (closed) {
      await closeQuietly(newServer);
      return;
    }
    // The old server holds the port, so it must close before the new one
    // listens — the down-window is now just this close+listen swap. Clearing
    // `current` across the window keeps a concurrent close() (or a listen that
    // never succeeds) from closing the old server a second time, which is the
    // ERR_SERVER_NOT_RUNNING noise the idempotent teardown exists to avoid.
    if (current !== undefined) {
      const old = current;
      current = undefined;
      await closeQuietly(old);
    }
    // Only the bind is guarded here. Reporting the success sits AFTER the
    // catch on purpose: inside it, a notifier that throws (stderr closed by
    // `aai dev | head`) was reported as a failed listen and tore down a server
    // that had already bound — logging must not be able to take the dev server
    // down. Such a throw escapes to request()'s catch instead.
    try {
      await listenWithRetry(newServer);
    } catch (err) {
      ops.notify(
        "error",
        `Restart failed: ${errorMessage(err)} — dev server is down; save a file to retry.`,
      );
      await closeQuietly(newServer);
      return;
    }
    current = newServer;
    if (closed) {
      // Teardown raced with the swap: it closed the old server, so shut the
      // new one down too rather than leaving it listening forever.
      await closeQuietly(newServer);
      return;
    }
    ops.notify("success", "Restarted");
  }

  /**
   * Listen with a few short-backoff retries. During the close→listen swap the
   * port is momentarily free, so another process can snatch it (or the OS can
   * hold it in TIME_WAIT); one blind attempt would leave the dev server down
   * until the next file change.
   */
  async function listenWithRetry(server: S): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await ops.listen(server);
        return;
      } catch (err) {
        if (attempt >= LISTEN_ATTEMPTS || closed) throw err;
        await wait(LISTEN_RETRY_DELAY_MS);
      }
    }
  }

  /** Best-effort close: a synchronous throw is swallowed alongside a rejection. */
  async function closeQuietly(server: S): Promise<void> {
    try {
      await ops.close(server);
    } catch {
      /* ignore */
    }
  }

  return {
    request,
    adopt(server: S): void {
      current = server;
      restarting = false;
      if (pendingRestart) request();
    },
    current: () => current,
    // Idempotent: SIGINT followed by SIGTERM must not run the teardown twice
    // concurrently (double server close → ERR_SERVER_NOT_RUNNING noise, double
    // runtime shutdown). The second call joins the in-flight teardown.
    close(): Promise<void> {
      cleanupPromise ??= (async () => {
        closed = true;
        // Each close is best-effort: one failing must not leak the others.
        await ops.teardown?.().catch(() => undefined);
        if (current !== undefined) await closeQuietly(current);
      })();
      return cleanupPromise;
    },
  };
}
