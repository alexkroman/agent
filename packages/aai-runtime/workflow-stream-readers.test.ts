// Copyright 2026 the AAI authors. MIT license.
/**
 * Every world stream the SDK opens to read a run must be CANCELLED.
 *
 * ## The defect this exists for
 *
 * `WorkflowClient.stream()` and `.streamTail()` both go through
 * `getRun(id).getReadable()`, which is a deserialize `TransformStream` fed by a
 * background pump (`flushablePipe`) reading `createReconnectingFramedStream`,
 * which reads the WORLD. On the local world a world read is a `chunk:<stream>`
 * and a `close:<stream>` listener on a process-wide `EventEmitter`, so a world
 * read nobody cancels is a listener pair nobody removes — and, worse, a live
 * reader that goes on copying every later chunk into a buffer nothing drains.
 *
 * `createReconnectingFramedStream` guarded its `cancel` on the reader handle
 * that its own async `connect()` assigns LAST. The pump starts that connect the
 * moment the stream is constructed, so a cancel arriving while it was in flight
 * detached nothing, and connect then published a reader with nobody left to
 * close it. Fixed in `patches/@workflow__core@4.8.2.patch`.
 *
 * In the field it looked like this, from a page using the spoken-summary
 * template's `<WorkflowProgress>`:
 *
 * ```text
 * Guest: listener leak suspected on "chunk:strm_01M0GS…_user" — 11 listeners
 * Guest: listener leak GROWING on "chunk:strm_01M0GS…_user" — 45 listeners (was 11)
 * ```
 *
 * — one pair per second, which is `useWorkflowProgress`'s poll interval.
 *
 * ## Why the world is INJECTED rather than real
 *
 * The leak is invisible to a fake STREAM (a fake attaches no listeners and is
 * cancelled by construction), which is why the route's own unit suite was green
 * throughout. But it is fully visible to a fake WORLD, because the world is
 * exactly where the resource is acquired: `readFromStream` is the open, its
 * stream's `cancel` is the close, and the invariant is that the two counts
 * match. That makes this a unit test — no filesystem, no data directory, no
 * `process.chdir` (which vitest's worker pool forbids anyway) — testing the
 * contract itself rather than one world's implementation of it.
 *
 * The one thing the fake must not simplify away is that a world read TAKES
 * TIME. The race lives in the gap between the open being requested and the
 * reader being published, and the teardown chain a cancel travels is itself
 * several microtasks long — so a fake resolving in one microtask always wins
 * that race and the suite passes against the unpatched DevKit. Verified both
 * ways: with `await Promise.resolve()` all three cases pass unpatched; with the
 * millisecond below, two fail unpatched and all three pass patched.
 *
 * Which two fail is a property of the FAKE's timing rather than of the field,
 * so do not read the case names as a history of what leaked in production —
 * against the real local world only the third shape did. What every case
 * asserts is the one invariant that matters and holds regardless: a world
 * stream this SDK opens is a world stream it cancels.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sleep } from "./_test-utils.ts";

/** The run these reads name. */
const RUN_ID = "wrun_01LEAKLEAKLEAKLEAKLEAKLEAK";
/** Enough repetitions that a per-read leak is unmistakable rather than a rounding error. */
const READS = 12;

/** How many world streams have been opened, and how many of those were cancelled. */
type OpenLedger = { opened: number; cancelled: number };

/**
 * The DevKit's `World`, reached through the runtime module's own signature.
 *
 * `@workflow/world` owns the interface, but it is a transitive dependency here
 * rather than a declared one — so it is read off the function that consumes it
 * instead, which keeps the fake below honest without this package taking a
 * dependency on a package it does not import.
 */
type WorldArg = Parameters<typeof import("workflow/runtime")["setWorld"]>[0];
/** The same, without the `undefined` that clearing the world allows. */
type World = NonNullable<WorldArg>;

/**
 * The slice of `World` the fake below really implements.
 *
 * A `World` is some twenty-seven members across `Queue`, `Storage` and
 * `Streamer`, so a fake that satisfied it outright would be a hundred lines of
 * throwing stubs for methods this test never reaches. Naming the slice instead
 * buys the half that matters: the three stream members are checked against the
 * DevKit's own signatures, so a fake that drifts out of step with the interface
 * it stands in for fails to COMPILE — where a `Record<string, unknown>` return
 * type checked none of them and a rename would have left this suite passing
 * against a shape no real world has.
 */
type WorldSlice = Pick<World, "specVersion" | "readFromStream" | "getStreamInfo"> & {
  /** Narrower than the real overloaded `runs`, which this fake only ever rejects from. */
  runs: { get: () => Promise<never> };
};

/**
 * The one widening in this file: a partial fake of a third-party interface
 * cannot be assigned to it. Concentrating it here is what lets every member of
 * `WorldSlice` stay genuinely type-checked at the fake's own definition.
 */
function asWorld(slice: WorldSlice): World {
  return slice as unknown as World;
}

let ledger: OpenLedger;
/** The DevKit's run handle. Resolved dynamically, so its type is not in scope here. */
let run: {
  getReadable(options: object): ReadableStream<unknown> & { getTailIndex(): Promise<number> };
};
let restoreWorld: () => void;

/**
 * A world that answers only what reading a run's stream asks of it.
 *
 * The stream it hands back never yields and never closes, which is what a
 * progress channel mid-run IS — no step knows it is the last, so nothing closes
 * it. That is also what makes an uncancelled read permanent rather than merely
 * slow.
 */
function ledgerWorld(into: OpenLedger): WorldSlice {
  return {
    specVersion: 2,
    async readFromStream(): Promise<ReadableStream<Uint8Array>> {
      // The delay is load-bearing — see the module doc. The teardown chain a
      // cancel travels (transform → pump → reconnecting stream) is itself
      // several microtasks long, so a fake that resolves in ONE always loses the
      // race and this suite would pass against the unpatched DevKit — verified.
      // A real world read crosses telemetry wrappers and the filesystem; a
      // millisecond is a conservative stand-in for that.
      await sleep(1);
      into.opened += 1;
      return new ReadableStream<Uint8Array>({
        cancel() {
          into.cancelled += 1;
        },
      });
    },
    async getStreamInfo(): Promise<{ tailIndex: number; done: boolean }> {
      // Same cost as the read above, deliberately: a tail lookup is a world
      // round-trip too, and a fake that answers it instantly would make
      // `streamTail` look like it loses a race that, against a real world, it
      // wins.
      await sleep(1);
      return { tailIndex: -1, done: false };
    },
    runs: {
      get: (): Promise<never> => Promise.reject(new Error("no run record in this fake")),
    },
  };
}

beforeEach(async () => {
  ledger = { opened: 0, cancelled: 0 };
  const { getWorld, setWorld } = await import("workflow/runtime");
  const { getRun } = await import("workflow/api");
  // Captured rather than assumed: another suite in this process may have
  // resolved a world already, and leaving ours installed would leak across files.
  let previous: WorldArg;
  try {
    previous = getWorld();
  } catch {
    previous = undefined;
  }
  setWorld(asWorld(ledgerWorld(ledger)));
  restoreWorld = (): void => setWorld(previous);
  run = getRun(RUN_ID) as typeof run;
});

afterEach(() => {
  restoreWorld();
});

/** Let the cancels settle — teardown crosses a pump, a transform and a world read. */
async function settle(): Promise<void> {
  await sleep(50);
}

describe("every world stream opened to read a run is cancelled", () => {
  test("streamTail: construct, ask the index, cancel", async () => {
    for (let i = 0; i < READS; i += 1) {
      const readable = run.getReadable({});
      try {
        await readable.getTailIndex();
      } finally {
        await readable.cancel().catch(() => undefined);
      }
    }
    await settle();
    expect(ledger.cancelled).toBe(ledger.opened);
  });

  test("a read cancelled without reading — the caught-up poll", async () => {
    // This is the shape that leaked in the field. `useWorkflowProgress` advances
    // `startIndex` by what it has consumed and re-reads once a second, so every
    // poll during a step that writes nothing asks for a budget of zero: the
    // route opened a stream, read no chunks from it, and cancelled — before the
    // background connect had published the reader that cancel looks for.
    for (let i = 0; i < READS; i += 1) {
      const reader = run.getReadable({}).getReader();
      await reader.cancel().catch(() => undefined);
    }
    await settle();
    expect(ledger.opened).toBeGreaterThan(0);
    expect(ledger.cancelled).toBe(ledger.opened);
  });

  test("a read cancelled after its connect resolved", async () => {
    // The CONTROL: a cancel that arrives after the connect published its reader
    // has always been safe, patched or not. It is here so a failure above reads
    // as "an early cancel regressed" rather than "reading a run's stream leaks".
    for (let i = 0; i < READS; i += 1) {
      const reader = run.getReadable({}).getReader();
      await sleep(5);
      await reader.cancel().catch(() => undefined);
    }
    await settle();
    expect(ledger.cancelled).toBe(ledger.opened);
  });
});
