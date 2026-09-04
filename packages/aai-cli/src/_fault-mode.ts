// Copyright 2026 the AAI authors. MIT license.
/**
 * Fault mode: run a test's dev server as a child that gets HARD-KILLED and
 * restarted at declared points, so a suite can be run against a process that
 * keeps dying under it.
 *
 * `AAI_FAULT_PROFILE=<name>` turns it on for every test that boots its server
 * through {@link startSupervisedDevServer}; unset, the helper is an ordinary
 * spawn and nothing about a suite changes. That is the whole shape of the
 * feature: one env var covers the suite, and the off path has no supervisor in
 * it at all.
 *
 * ## Why the kill is a SIGKILL, and why that is the only faithful option
 *
 * A graceful stop lets graphile-worker's runner release the queue locks it
 * holds. That is exactly the difference that decides whether an in-flight step
 * is redelivered, so a fault mode built on SIGTERM would exercise the recovery
 * path that already works and never the one that does not. Measured: one hard
 * kill of the process (or of its Postgres) strands every locked step until
 * graphile-worker's own `interval '4 hours'` reclaim, with the run sitting
 * `running` and a page showing "Working…" forever.
 *
 * ## Why there is no seed and no PRNG
 *
 * "Consistent fault mode" is the requirement, and the cheapest way to be
 * consistent is to have nothing to reproduce: a profile is an ORDERED LIST of
 * fault points keyed on logical events, so the Nth kill lands after the same
 * observed event on every machine at every speed. Wall-clock kills are what
 * `tmp/transcribe-load/chaos.mjs` does, and they are why its runs cannot be
 * compared to each other.
 *
 * Randomized exploration is a different job with a different tool: this repo
 * drives every randomized suite with fast-check (see "Property tests run on
 * fast-check" in the root guide) precisely so nobody hand-rolls a seventh PRNG.
 * A fault mode that grew a seed would be that seventh. If the fault SCHEDULE
 * should be explored rather than declared, that belongs in a fast-check
 * property over this module's plan type, not in an env var here.
 *
 * ## Triggers are log lines, and the plan is CHECKED
 *
 * A fault point names a pattern the server writes and which occurrence to fire
 * on. Keying on log output couples this to strings the server happens to print,
 * which is a real cost and is accepted for one reason: the alternative is a
 * fault hook in production code, and a test-only mechanism should not be able to
 * fire in production at all.
 *
 * The cost is paid down by {@link SupervisedServer.assertPlanConsumed}, which
 * THROWS when a declared fault point never fired. Without it a renamed log line
 * turns the entire mode into a no-op and the suite passes "under faults" having
 * injected none — the failure this repo keeps paying for (a gate that reports
 * success while checking nothing). Call it before asserting anything else.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { sleep } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { waitForExit, waitForHealth } from "./_e2e-test-utils.ts";

/** How long to wait for a restarted server to answer `/health` before giving up. */
const HEALTH_TIMEOUT_MS = 60_000;

/** Interval between `awaitSettled` polls of the fault tracker. */
const SETTLE_POLL_MS = 100;

/**
 * One kill, described by what the server DID rather than by when — the two
 * kinds being a line it printed and a boot it completed.
 *
 * `downMs` holds the process down before the restart on either. The default is
 * 0, i.e. restart immediately, because the fault under test is the DEATH rather
 * than the downtime.
 *
 * Both kinds exist because a log trigger cannot reach the boot. `aai dev`
 * announces itself through `log.success`, which JSON mode SILENCES — and JSON
 * mode is what the e2e suite runs (and what a pipe auto-selects), so a
 * boot-level profile keyed on a startup line matched nothing and the mode
 * injected no faults at all. Workflow lines are unaffected: the agent server's
 * logger writes straight to stderr rather than through `log`, so
 * `"Workflow run started"` survives JSON mode. `afterHealthy` needs no log at
 * all, which makes it the right kind for anything about the process lifecycle.
 */
export type FaultPoint =
  | {
      /** A substring of the log line to fire after. */
      after: string;
      /** Which occurrence of `after` to fire on. 1-based; defaults to the first. */
      nth?: number;
      /** Milliseconds to stay down. Defaults to 0. */
      downMs?: number;
      afterHealthy?: never;
    }
  | {
      /**
       * Fire once the server has answered `/health` this many times — the first
       * boot is 1, the generation after one restart is 2.
       */
      afterHealthy: number;
      downMs?: number;
      after?: never;
      nth?: never;
    };

/** How a fault point reads in a failure message. */
function label(point: FaultPoint): string {
  return point.after === undefined
    ? `afterHealthy ${point.afterHealthy}`
    : `${JSON.stringify(point.after)} (nth ${point.nth ?? 1})`;
}

/**
 * The plan's bookkeeping: which point, if any, a given observation completes.
 *
 * Split from the supervisor so that DECIDING and KILLING are two things. The
 * decision is all the fiddly part — occurrence counting, `nth` across restarts,
 * never firing a point twice — and none of it needs a process, which is what
 * makes it readable and what keeps `startSupervisedDevServer` inside the
 * cognitive-complexity limit without an escape hatch.
 */
function createFaultTracker(points: readonly FaultPoint[]) {
  /** Occurrences seen per `after` pattern, counted across every generation. */
  const seen = new Map<string, number>();
  const fired = new Set<number>();

  return {
    firedCount: () => fired.size,
    outstanding: (): FaultPoint[] => points.filter((_point, index) => !fired.has(index)),

    /**
     * Count a line, then resolve the point it completes.
     *
     * Counting happens for EVERY matching pattern BEFORE any point is
     * considered, and that ordering is the whole correctness of `nth`. Counting
     * inside the point loop (and skipping points that had already fired) meant a
     * pattern stopped advancing once its first point fired — so
     * `restart-mid-step`, which declares `nth: 1` and `nth: 3` on one pattern,
     * injected one kill of its two while reporting the second as a renamed log
     * line.
     */
    onLine: (line: string): FaultPoint | undefined => {
      const reached = new Map<string, number>();
      for (const point of points) {
        const pattern = point.after;
        if (pattern === undefined || reached.has(pattern) || !line.includes(pattern)) continue;
        const count = (seen.get(pattern) ?? 0) + 1;
        seen.set(pattern, count);
        reached.set(pattern, count);
      }
      return take(
        (point) => point.after !== undefined && reached.get(point.after) === (point.nth ?? 1),
      );
    },

    /** Resolve the point completed by the server's `healthy`th successful boot. */
    onHealthy: (healthy: number): FaultPoint | undefined =>
      take((point) => point.afterHealthy === healthy),
  };

  /** The first unfired point matching `matches`, marked fired. */
  function take(matches: (point: FaultPoint) => boolean): FaultPoint | undefined {
    for (const [index, point] of points.entries()) {
      if (fired.has(index) || !matches(point)) continue;
      fired.add(index);
      return point;
    }
    return undefined;
  }
}

export type FaultProfile = {
  description: string;
  points: readonly FaultPoint[];
};

/**
 * The declared profiles.
 *
 * Named scenarios rather than knobs, so a suite run says what it exercised and
 * a failure names something a reader can picture. Add one here rather than
 * assembling a plan at a call site — a plan that lives in one test cannot be
 * run across the suite, which is the point of the mode.
 */
export const FAULT_PROFILES: Readonly<Record<string, FaultProfile>> = {
  /** One kill immediately after a run begins, before any step has settled. */
  "restart-on-run-start": {
    description: "SIGKILL just after the first workflow run starts",
    points: [{ after: "Workflow run started" }],
  },
  /**
   * A kill after a step has reported, i.e. with journaled work behind it and
   * work in flight. This is the one that reaches the redelivery path.
   */
  "restart-mid-step": {
    description: "SIGKILL after the first step reports, then again after the third",
    points: [
      { after: "Workflow:", nth: 1 },
      { after: "Workflow:", nth: 3 },
    ],
  },
  /**
   * Two kills around the boot itself — the profile to run a WHOLE SUITE under,
   * because every supervised server boots and so every test gets its faults. A
   * log-keyed profile cannot make that claim: a test that starts no workflow
   * prints no workflow line.
   */
  "restart-on-boot": {
    description: "SIGKILL after each of the first two successful boots",
    points: [
      { afterHealthy: 1, downMs: 250 },
      { afterHealthy: 2, downMs: 250 },
    ],
  },
};

/**
 * The profile `AAI_FAULT_PROFILE` names, or undefined when the mode is off.
 *
 * An unknown name THROWS naming the declared set rather than degrading to off:
 * a typo would otherwise produce a green run that injected nothing, which is
 * indistinguishable from a healthy one and is the failure this whole module is
 * careful about.
 */
export function resolveFaultProfile(
  name: string | undefined = process.env.AAI_FAULT_PROFILE,
): FaultProfile | undefined {
  if (name === undefined || name === "" || name === "none") return undefined;
  const profile = FAULT_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown AAI_FAULT_PROFILE "${name}". Declared: ${Object.keys(FAULT_PROFILES).join(", ")}.`,
    );
  }
  return profile;
}

export type SupervisedServer = {
  /** Origin the server answers on, stable across restarts (the port is fixed). */
  url: string;
  /**
   * How many times the process has been killed and is BACK — incremented once
   * the replacement answers `/health`, so polling this to `n` means the nth
   * replacement is serving.
   */
  restarts: () => number;
  /**
   * Resolve once every declared fault point has fired AND the surviving
   * generation answers `/health`.
   *
   * This is the point a test should assert from: it is the only moment at which
   * "the faults happened and the server is back" is true, and without it a
   * request races the restart window — so every test would have to be written
   * retry-aware to survive a profile it does not know about. Resolves
   * immediately when the mode is off.
   *
   * Throws on timeout, naming the points that never fired — the same shortfall
   * {@link assertPlanConsumed} reports, surfaced at the moment a test waited for
   * it rather than at teardown.
   */
  awaitSettled: (timeoutMs?: number) => Promise<void>;
  /**
   * Throw unless every declared fault point fired.
   *
   * For a test whose SUBJECT is the profile. A test merely running under one
   * should call {@link awaitSettled} instead — a profile whose triggers that
   * test never produces (a step-level trigger in a test that runs no workflow)
   * would otherwise fail it for something that is not a bug.
   */
  assertPlanConsumed: () => void;
  /** Every line the server wrote, across all generations. */
  lines: () => readonly string[];
  stop: () => Promise<void>;
};

export type SupervisedDevServerOptions = {
  /** Absolute path to the CLI entry (`bin.mjs`). */
  aaiBin: string;
  /** The project directory to run in. */
  cwd: string;
  /** A fixed port: the URL has to survive a restart. */
  port: number;
  env: NodeJS.ProcessEnv;
  /** Extra `aai dev` arguments. */
  args?: readonly string[];
  /** Defaults to `resolveFaultProfile()`. Pass one to drive the mode from a test. */
  profile?: FaultProfile | undefined;
  /**
   * How long a restarted server has to answer `/health`. Defaults to
   * {@link HEALTH_TIMEOUT_MS}.
   *
   * A test seam, and one worth having: the ONLY way to exercise "the server did
   * not survive a kill this mode inflicted" is to let that wait expire, and at
   * the shipped 60s that is a minute of wall clock per assertion.
   */
  healthTimeoutMs?: number | undefined;
  /**
   * The host `url` names, and so the one `/health` is polled on. Defaults to
   * `127.0.0.1`; a project WITH a client.tsx needs `localhost`.
   *
   * Vite owns `port` there and binds its default `server.host` — the NAME
   * `localhost`, which is `::1` on macOS. Measured with `lsof`:
   *
   *     node  TCP 127.0.0.1:4834 (LISTEN)   <- the backend, IPv4
   *     node  TCP [::1]:4833    (LISTEN)   <- Vite, IPv6 loopback only
   *
   * so the hardcoded `127.0.0.1` this replaces was refused for the full 60s
   * against a server that had already announced itself. `localhost` rather
   * than `::1` because Node connects with `autoSelectFamily`: the name tries
   * both families, and holds on a runner that binds the v4 address instead.
   */
  host?: string | undefined;
};

/**
 * Boot `aai dev` as a child and, under a fault profile, keep killing it.
 *
 * With no profile this is a plain spawn plus a health wait — the same thing the
 * e2e suite did inline — so converting a test to it changes nothing until the
 * env var is set.
 */
export async function startSupervisedDevServer(
  opts: SupervisedDevServerOptions,
): Promise<SupervisedServer> {
  const profile = opts.profile ?? resolveFaultProfile();
  const points = profile?.points ?? [];
  const url = `http://${opts.host ?? "127.0.0.1"}:${opts.port}`;
  const lines: string[] = [];
  const tracker = createFaultTracker(points);
  /** Successful boots so far, which is what `afterHealthy` counts. */
  let healthy = 0;
  let restarts = 0;
  let child: ChildProcess | undefined;
  let stopped = false;
  /** Serializes kills: two triggers in one chunk must not race each other. */
  let cycle: Promise<void> = Promise.resolve();
  /**
   * The first restart that never came back, held so it can be REPORTED.
   *
   * A rejection has to be taken off `cycle` the moment it is created (see
   * {@link fire}) — but taking it off and dropping it would hide the one
   * failure this mode exists to produce, so it is kept here and re-raised by
   * `awaitSettled` / warned about by `stop`.
   */
  let restartFailure: unknown;

  const spawnOnce = async (): Promise<void> => {
    const next = spawn(
      process.execPath,
      [opts.aaiBin, "dev", "--port", String(opts.port), ...(opts.args ?? [])],
      { cwd: opts.cwd, env: opts.env, stdio: "pipe" },
    );
    child = next;
    for (const stream of [next.stdout, next.stderr]) {
      let held = "";
      stream?.setEncoding("utf-8");
      stream?.on("data", (text: string) => {
        held += text;
        const parts = held.split("\n");
        held = parts.pop() ?? "";
        for (const line of parts) {
          lines.push(line);
          if (!stopped) fire(tracker.onLine(line));
        }
      });
    }
    await waitForHealth(`${url}/health`, next, opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
    healthy += 1;
    fire(tracker.onHealthy(healthy));
  };

  /**
   * Queue a kill for a point the tracker just resolved.
   *
   * Queued rather than awaited because both callers run on a synchronous path —
   * a stream callback, or the tail of a boot — and an async kill started inline
   * would interleave with the next chunk.
   */
  const fire = (point: FaultPoint | undefined): void => {
    if (point === undefined || stopped) return;
    // The handler is attached HERE rather than in `stop()`. `cycle.then(...)`
    // mints a promise whose rejection — a replacement that never answered
    // `/health` — has no handler for as long as it takes the suite to reach
    // teardown, which is seconds; Node reports that as an unhandledRejection,
    // failing whichever test happened to be running and naming the wrong
    // thing. Recorded instead, which is what `stop`'s comment always intended:
    // reported rather than swallowed, on the channel that names it.
    cycle = cycle
      .then(() => recycle(point))
      .catch((err: unknown) => {
        restartFailure ??= err;
      });
  };

  /**
   * Drop the handle, signal, wait for the exit — in that order, so nothing
   * running while the exit is awaited can signal the same child twice.
   */
  const reap = async (signal?: NodeJS.Signals): Promise<void> => {
    const dying = child;
    child = undefined;
    dying?.kill(signal);
    if (dying) await waitForExit(dying, 10_000);
  };

  /** SIGKILL, hold, bring it back. */
  const recycle = async (point: FaultPoint): Promise<void> => {
    if (stopped) return;
    await reap("SIGKILL");
    if (point.downMs !== undefined && point.downMs > 0) {
      await sleep(point.downMs);
    }
    if (stopped) return;
    await spawnOnce();
    // Incremented AFTER the replacement answers `/health`, so `restarts()`
    // means "killed and back" rather than "being brought back". A caller polling
    // it is otherwise told the restart happened while the new process has not
    // bound its socket or written its first line — which is a race every
    // consumer would have to know to work around.
    restarts += 1;
  };

  await spawnOnce();

  /** The shortfall, or undefined when the plan is fully injected. */
  const shortfall = (): string | undefined => {
    const missed = tracker.outstanding();
    if (missed.length === 0) return undefined;
    // The tail of what the server actually said. A missed log trigger is almost
    // always a renamed line, and the answer is in these lines — without them the
    // reader's next step is to re-run the whole suite with a print statement in
    // it, which for the e2e tier is minutes per attempt.
    const tail = lines.slice(-12);
    return (
      `Fault profile "${profile?.description ?? "?"}" injected ${tracker.firedCount()} of ` +
      `${points.length} fault(s): never matched ${missed.map(label).join(", ")}. The run had ` +
      "fewer faults in it than it declared — usually a server log line that was renamed. " +
      "Note JSON mode silences `log.*` (so a startup line is unreachable — use " +
      `\`afterHealthy\`), while the agent server's own logger writes to stderr and is not ` +
      `silenced.${tail.length > 0 ? `\nLast lines seen:\n  ${tail.join("\n  ")}` : ""}`
    );
  };

  return {
    url,
    restarts: () => restarts,
    lines: () => lines,
    awaitSettled: async (timeoutMs = 60_000) => {
      if (points.length === 0) return;
      const deadline = Date.now() + timeoutMs;
      while (tracker.firedCount() < points.length) {
        if (Date.now() > deadline) throw new Error(shortfall() ?? "fault plan did not settle");
        await sleep(SETTLE_POLL_MS);
      }
      // Every kill has FIRED, but the last one's restart may still be in flight:
      // `cycle` is the queue those kills run on, so awaiting it is what makes
      // "settled" include the replacement being healthy again.
      await cycle;
      // `cycle` no longer rejects (see `fire`), so the failure is re-raised
      // here — a caller awaiting "the faults are done and the server is back"
      // must not be told yes when it never came back.
      if (restartFailure !== undefined) {
        throw new Error(`a restart never became healthy: ${errorMessage(restartFailure)}`, {
          cause: restartFailure,
        });
      }
    },
    assertPlanConsumed: () => {
      const missed = shortfall();
      if (missed !== undefined) throw new Error(missed);
    },
    stop: async () => {
      stopped = true;
      // A suite-wide run does not call `assertPlanConsumed` (see its doc), so a
      // profile that matched NOTHING would otherwise be invisible — the exact
      // silence this module is built against. Warn rather than throw: the test
      // that is finishing did nothing wrong, and its failure would name the
      // wrong thing.
      if (points.length > 0 && tracker.firedCount() === 0)
        console.warn(`aai fault mode: ${shortfall()}`);
      // A restart that failed — a replacement that never answered `/health` —
      // must not stop teardown, since the process still has to be reaped. It is
      // REPORTED rather than swallowed: it means the server did not survive a
      // kill this mode inflicted, which is a finding, and silence here would
      // hide the one failure the mode exists to produce. The rejection itself
      // was taken off `cycle` when it happened — see `fire`.
      await cycle;
      if (restartFailure !== undefined) {
        console.warn(
          `aai fault mode: a restart never became healthy: ${errorMessage(restartFailure)}`,
        );
      }
      await reap();
    },
  };
}
