// Copyright 2026 the AAI authors. MIT license.
/**
 * Restart supervision for `aai dev`, as a statechart.
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
 *
 * ## Teardown is LEAVING `rebuilding`, which is what deletes the `closed` checks
 *
 * This was a `booting`/`queuedDuringBoot`/`closed` latch set plus a
 * `createCoalescingRunner` over an async `restartOnce`, which re-read `closed`
 * after every `await` — after the build, after the listen, between listen
 * attempts — because a teardown could land at any of them. Each step is now an
 * invoked actor of its own state, so `CLOSE` exits the step and stops it, and
 * its outcome is never delivered: the re-check is the machine.
 *
 * Stopping an actor does not cancel the operation under it, though, and the
 * step that was in flight is holding a server nobody else knows about — the
 * one just built, or the one half-way through binding. So every step that
 * holds the REPLACEMENT disposes of it when its signal aborts, after its own
 * operation settles: closing a server whose `listen` is still in flight would
 * let the bind complete afterwards and leak the port. That disposal is
 * fire-and-forget, as the old early returns were — `close()` awaits teardown
 * and the CURRENT server, never an in-flight rebuild.
 *
 * ## Coalescing is a flag in context, not a runner
 *
 * At most one rebuild runs; every `REQUEST` landing during one (or during
 * boot) sets `queued`, and the rebuild's end — success, failed build, failed
 * listen — re-enters `rebuilding` once if it is set. That is the
 * `createCoalescingRunner` contract restated as a transition, and the policy
 * is the same: a rebuild reads the files as they are WHEN IT RUNS, so N queued
 * rebuilds would do the trailing one's work N times, while dropping the
 * trigger would leave the newest save unserved.
 *
 * ## Actions never throw
 *
 * A throwing action ERRORS an XState actor for good, which would wedge
 * watching — the old runner's "a rejection never wedges" property. The one
 * effect that can throw on an ordinary path is `notify` (stderr closed by
 * `aai dev | head`), so it goes through {@link report}, which falls back to
 * reporting the throw itself and then swallows.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
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

/** Best-effort close: a synchronous throw is swallowed alongside a rejection. */
async function closeQuietly<S>(ops: RestartOps<S>, server: S): Promise<void> {
  try {
    await ops.close(server);
  } catch {
    /* ignore */
  }
}

/**
 * Notify without ever throwing. A failing notifier is reported as a failed
 * restart (what reached the old `request()` catch), and a second failure is
 * dropped — there is nowhere left to say it.
 */
function report<S>(ops: RestartOps<S>, level: NotifyLevel, message: string): void {
  try {
    ops.notify(level, message);
  } catch (err) {
    try {
      ops.notify("error", `Restart failed: ${errorMessage(err)}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run `step`, then — if the owning state was left meanwhile — close `server`,
 * which nothing else will. Waiting for `step` first is the point: see the
 * module comment on closing a server mid-`listen`.
 */
async function disposingOnAbort<S, T>(
  signal: AbortSignal,
  ops: RestartOps<S>,
  server: S,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } finally {
    if (signal.aborted) await closeQuietly(ops, server);
  }
}

/** The supervisor's events. `CLOSE` is sent by `close()`, before anything awaits. */
type RestartEvent<S> = { type: "REQUEST" } | { type: "ADOPT"; server: S } | { type: "CLOSE" };

type RestartContext<S> = {
  ops: RestartOps<S>;
  /** The server serving the port, cleared across the close→listen swap. */
  current: S | undefined;
  /** The replacement this rebuild is building / swapping in. */
  next: S | undefined;
  /** The server `swapping` is closing; out of `current` for the swap. */
  old: S | undefined;
  /** A change landed during boot or the in-flight rebuild: run one more. */
  queued: boolean;
  /** The listen attempt in flight, 1-based. */
  attempt: number;
};

type Step<S> = { ops: RestartOps<S>; server: S };

function restartMachine<S>() {
  return setup({
    types: {} as {
      context: RestartContext<S>;
      input: RestartOps<S>;
      events: RestartEvent<S>;
    },
    actors: {
      /** A server built after its state was left is closed rather than orphaned. */
      build: fromPromise(
        async ({ input, signal }: { input: RestartOps<S>; signal: AbortSignal }) => {
          const server = await input.build();
          if (signal.aborted) await closeQuietly(input, server);
          return server;
        },
      ),
      /** Close the OLD server so the replacement can bind its port. */
      swap: fromPromise(({ input, signal }: { input: Step<S> & { old: S }; signal: AbortSignal }) =>
        disposingOnAbort(signal, input.ops, input.server, () => closeQuietly(input.ops, input.old)),
      ),
      listen: fromPromise(({ input, signal }: { input: Step<S>; signal: AbortSignal }) =>
        disposingOnAbort(signal, input.ops, input.server, () => input.ops.listen(input.server)),
      ),
      backoff: fromPromise(({ input, signal }: { input: Step<S>; signal: AbortSignal }) =>
        disposingOnAbort(signal, input.ops, input.server, () =>
          (input.ops.sleep ?? sleep)(LISTEN_RETRY_DELAY_MS),
        ),
      ),
      /** Close a replacement that never bound. Not interruptible: it IS the cleanup. */
      discard: fromPromise(({ input }: { input: Step<S> }) =>
        closeQuietly(input.ops, input.server),
      ),
      /** Teardown first, then the serving server; each best-effort. */
      shutdown: fromPromise(
        async ({ input }: { input: { ops: RestartOps<S>; current: S | undefined } }) => {
          try {
            await input.ops.teardown?.();
          } catch {
            /* one leak must not strand the others */
          }
          if (input.current !== undefined) await closeQuietly(input.ops, input.current);
        },
      ),
    },
    guards: {
      queued: ({ context }) => context.queued,
      hasCurrent: ({ context }) => context.current !== undefined,
      canRetry: ({ context }) => context.attempt < LISTEN_ATTEMPTS,
    },
    actions: {
      queue: assign({ queued: true }),
      /**
       * Refused after a teardown, rather than orphaning the server the caller
       * just built: `CLOSE` during boot found no current server and closed
       * nothing, so without this the freshly listening server would keep its
       * port bound for the life of the process.
       */
      refuseAdopt: ({ context, event }) => {
        if (event.type === "ADOPT") void closeQuietly(context.ops, event.server);
      },
    },
  }).createMachine({
    id: "devRestart",
    context: ({ input }) => ({
      ops: input,
      current: undefined,
      next: undefined,
      old: undefined,
      queued: false,
      attempt: 1,
    }),
    // Startup is not a restart, but it is a window in which a change must
    // QUEUE rather than race the initial build — which runs outside the
    // machine, and is released by `adopt`.
    initial: "booting",
    on: { CLOSE: { target: ".closed" } },
    states: {
      booting: {
        on: {
          REQUEST: { actions: "queue" },
          ADOPT: [
            {
              guard: "queued",
              target: "rebuilding",
              actions: assign({ current: ({ event }) => event.server }),
            },
            { target: "idle", actions: assign({ current: ({ event }) => event.server }) },
          ],
        },
      },
      idle: { on: { REQUEST: { target: "rebuilding" } } },
      rebuilding: {
        entry: assign({ queued: false, attempt: 1, next: undefined }),
        on: { REQUEST: { actions: "queue" } },
        // Every way a rebuild ends lands in `done`, and the trailing rebuild
        // starts from here whatever the outcome: the newest save still needs
        // serving, and after a failed listen it is the only way back up.
        onDone: [{ guard: "queued", target: "rebuilding", reenter: true }, { target: "idle" }],
        initial: "building",
        states: {
          // The slow part (full bundle + runtime construction), done FIRST:
          // the old server keeps serving the whole time, and a failed build (a
          // mid-edit syntax error) leaves it running.
          building: {
            invoke: {
              src: "build",
              input: ({ context }) => context.ops,
              onDone: [
                {
                  guard: "hasCurrent",
                  target: "swapping",
                  actions: assign({
                    next: ({ event }) => event.output,
                    old: ({ context }) => context.current,
                    current: undefined,
                  }),
                },
                { target: "listening", actions: assign({ next: ({ event }) => event.output }) },
              ],
              onError: {
                target: "done",
                actions: ({ context, event }) =>
                  report(
                    context.ops,
                    "error",
                    `Restart failed: ${errorMessage(event.error)} (previous server still running)`,
                  ),
              },
            },
          },
          // The old server holds the port, so it closes before the new one
          // listens — the down-window is just this swap. Clearing `current`
          // on the way in (the transition above) keeps a concurrent close() (or a listen that never
          // succeeds) from closing the old server a second time, which is the
          // ERR_SERVER_NOT_RUNNING noise the idempotent teardown avoids.
          swapping: {
            invoke: {
              src: "swap",
              input: ({ context }) => ({
                ops: context.ops,
                server: context.next as S,
                old: context.old as S,
              }),
              onDone: { target: "listening", actions: assign({ old: undefined }) },
            },
          },
          // During the swap the port is momentarily free, so another process
          // can snatch it (or the OS hold it in TIME_WAIT); one blind attempt
          // would leave the dev server down until the next save.
          listening: {
            invoke: {
              src: "listen",
              input: ({ context }) => ({ ops: context.ops, server: context.next as S }),
              // Reporting success is an action of the transition, not inside
              // the listen step: a notifier that throws must not be read as a
              // failed listen and tear down a server that already bound.
              onDone: {
                target: "done",
                actions: [
                  assign({ current: ({ context }) => context.next, next: undefined }),
                  ({ context }) => report(context.ops, "success", "Restarted"),
                ],
              },
              onError: [
                {
                  guard: "canRetry",
                  target: "backoff",
                  actions: assign({ attempt: ({ context }) => context.attempt + 1 }),
                },
                {
                  target: "discarding",
                  actions: ({ context, event }) =>
                    report(
                      context.ops,
                      "error",
                      `Restart failed: ${errorMessage(event.error)} — dev server is down; save a file to retry.`,
                    ),
                },
              ],
            },
          },
          backoff: {
            invoke: {
              src: "backoff",
              input: ({ context }) => ({ ops: context.ops, server: context.next as S }),
              onDone: { target: "listening" },
            },
          },
          discarding: {
            invoke: {
              src: "discard",
              input: ({ context }) => ({ ops: context.ops, server: context.next as S }),
              onDone: { target: "done", actions: assign({ next: undefined }) },
            },
          },
          done: { type: "final" },
        },
      },
      /**
       * Torn down. Deliberately NOT `type: "final"`: a final actor stops, and
       * this one still has a job — an `ADOPT` from a boot that finished after
       * Ctrl-C must close that server — and xstate warns on a send to a
       * stopped actor, which `request()` after teardown would trigger.
       * `REQUEST` and a second `CLOSE` are simply unhandled here.
       */
      closed: {
        initial: "shuttingDown",
        on: { ADOPT: { actions: "refuseAdopt" }, CLOSE: {} },
        states: {
          shuttingDown: {
            invoke: {
              src: "shutdown",
              input: ({ context }) => ({ ops: context.ops, current: context.current }),
              onDone: { target: "down" },
              onError: { target: "down" },
            },
          },
          down: {},
        },
      },
    },
  });
}

/**
 * Create a {@link RestartSupervisor}. It starts in the "restarting" state:
 * callers install their watcher and call {@link RestartSupervisor.request}
 * freely while the initial build runs, then {@link RestartSupervisor.adopt}
 * the built server (or {@link RestartSupervisor.close} on startup failure).
 */
export function createRestartSupervisor<S>(ops: RestartOps<S>): RestartSupervisor<S> {
  const actor = createActor(restartMachine<S>(), { input: ops }).start();
  let cleanupPromise: Promise<void> | undefined;
  return {
    request: () => actor.send({ type: "REQUEST" }),
    adopt: (server) => actor.send({ type: "ADOPT", server }),
    current: () => actor.getSnapshot().context.current,
    // Idempotent: SIGINT followed by SIGTERM must not run the teardown twice
    // concurrently (double server close → ERR_SERVER_NOT_RUNNING noise, double
    // runtime shutdown). The second call joins the in-flight teardown. A plain
    // closure, not a method: `_dev-server.ts` hands `supervisor.close` on
    // unbound.
    close(): Promise<void> {
      if (cleanupPromise === undefined) {
        // Sent synchronously, so an `adopt` or `request` in the same tick
        // already finds the supervisor closed.
        actor.send({ type: "CLOSE" });
        cleanupPromise = waitFor(actor, (s) => s.matches({ closed: "down" })).then(() => undefined);
      }
      return cleanupPromise;
    },
  };
}
