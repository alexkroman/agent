import { type ToolFailure, toolFailure } from "@alexkroman1/aai";
import {
  createKeyedLock,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  withLock,
} from "@alexkroman1/aai/utils";
import { FLEET, type Situation, TRUCK_FOR, type Truck, type TruckKind } from "./shared.ts";

/**
 * The yard's board: which truck is out, on whose call, and until when.
 *
 * **This is the one thing in the template that is NOT per-session**, and that
 * is the whole reason the file exists. Everything in `shared.ts` is a fact
 * about one caller and lives in a `sessionSlot`; a truck is a fact about the
 * DEPOT, and two callers who both need a van are competing for the same three
 * vehicles. `shared.ts` used to pretend otherwise — `assignTruck` returned the
 * first truck of the right kind and nothing marked it taken, so every
 * simultaneous caller on this line was promised `Van-3`.
 *
 * A shared resource reached through an `await` is exactly the case
 * `createKeyedLock` exists for, and the SDK's own note on it says why: **the
 * LLM loop runs a step's tool calls CONCURRENTLY**, so two bodies that read
 * this board, decide, and write it back interleave at every await and both
 * hand out the same callsign. A `sessionSlot` is not that case — `slot.update`
 * is a synchronous window — which is why the lock is here and not around any
 * of the other five tools.
 *
 * The lock is KEYED, and the key is the truck KIND rather than one global
 * mutex: two callers who both need a van have to take turns, and a van caller
 * and a flatbed caller have nothing to argue about. That is the whole
 * difference between this primitive and a single lock, stated in one line of
 * `reserveTruck`.
 *
 * `askTheYard` and `commit` stand in for the dispatch API a real desk calls.
 * Their `await` is not decoration: it is the yield point between reading the
 * board and writing it, and a spec next door drives two reservations across it
 * concurrently to prove the lock is what keeps them apart.
 */

/** What the yard has a truck committed to. */
interface Hold {
  /** The call it is out on — `ctx.sessionId`. */
  callKey: string;
  /** Epoch ms the yard expects the truck back and free again. */
  until: number;
}

/**
 * How long a reservation holds a truck: long enough to reach the caller, do
 * the job and clear it.
 *
 * A hold that has expired is treated as free rather than swept on a timer, so
 * nothing here needs a clock of its own and a spec can move time by passing
 * `now`.
 */
export const HOLD_MINUTES = 90;

/** How long a caller waits for the yard before the desk stops waiting for it. */
export const YARD_WAIT: KeyedLockOptions = { timeoutMs: 5000 };

/**
 * The yard's lock.
 *
 * Exported for one reader — the spec, which jams a key to prove the deadline
 * above really fires and reads `.size` to prove the lock drains rather than
 * leaking an entry per key. The agent never touches it directly.
 */
export const yardLock: KeyedLock = createKeyedLock();

const board = new Map<string, Hold>();

/**
 * Ask the yard what is already out, dropping anything whose hold has lapsed.
 *
 * The `await` is the point: a real desk asks a dispatch API here, and every
 * caller that reaches this line has yielded before it decides anything.
 */
async function askTheYard(now: number): Promise<Map<string, Hold>> {
  await Promise.resolve();
  for (const [callsign, hold] of board) {
    if (hold.until <= now) board.delete(callsign);
  }
  return board;
}

/** Write the reservation back. The second half of the read-decide-write. */
async function commit(callsign: string, hold: Hold): Promise<void> {
  await Promise.resolve();
  board.set(callsign, hold);
}

/**
 * A truck kind as the caller would hear it named.
 *
 * Takes a plain `string` because one of its two callers has a
 * {@link KeyedLockTimeoutError}'s `key`, which is the kind the lock was keyed
 * by and is typed as what a lock key is.
 */
function speak(kind: string): string {
  return kind.replaceAll("_", " ");
}

/**
 * Take a truck for this call, under the kind's lock.
 *
 * Idempotent on `callKey`, and that is what makes `onCall.dispatching`'s
 * `toolChoice` pin safe at the FLEET level as well as in the slot: the pinned
 * tool fires again on every later step of the call, and a call that already
 * holds a truck is handed the same one rather than a second.
 */
async function takeTruck(
  kind: TruckKind,
  callKey: string,
  now: number,
): Promise<Truck | ToolFailure> {
  const held = await askTheYard(now);
  const ours = FLEET.find((truck) => held.get(truck.callsign)?.callKey === callKey);
  if (ours) return ours;

  const free = FLEET.find((truck) => truck.kind === kind && !held.has(truck.callsign));
  if (!free) {
    return toolFailure(
      `Every ${speak(kind)} in the yard is out on another call. Tell the caller a supervisor ` +
        "will call back with a time, and do not promise one.",
    );
  }
  await commit(free.callsign, { callKey, until: now + HOLD_MINUTES * 60_000 });
  return free;
}

/** What a caller may change about a reservation. Both defaults are the live ones. */
export interface ReserveOptions {
  /** How long to wait for the yard's lock. Defaults to {@link YARD_WAIT}. */
  wait?: KeyedLockOptions;
  /** The clock, for a spec that needs a hold to have lapsed. */
  now?: number;
}

/**
 * The truck this call gets, reserved against the whole desk's fleet.
 *
 * A lapsed acquire is a `ToolFailure` rather than a throw, because this runs
 * mid-call: a stranded caller needs a sentence the model can say out loud, and
 * `KeyedLockTimeoutError` reaching the tool executor would be an exception down
 * a phone line. Anything else is re-thrown — a jammed yard is the only failure
 * this layer knows how to describe.
 */
export function reserveTruck(
  situation: Situation,
  callKey: string,
  options: ReserveOptions = {},
): Promise<Truck | ToolFailure> {
  const kind = TRUCK_FOR[situation];
  const now = options.now ?? Date.now();
  return withLock(
    yardLock,
    kind,
    () => takeTruck(kind, callKey, now),
    options.wait ?? YARD_WAIT,
  ).catch((err: unknown) => {
    if (err instanceof KeyedLockTimeoutError) {
      return toolFailure(
        `The yard did not answer about a ${speak(err.key)}. Tell the caller you ` +
          "are still working on a truck, and do not give them a callsign or a time.",
      );
    }
    throw err;
  });
}

/**
 * Put every truck back.
 *
 * For specs. The board outlives a session by design — that is what makes it the
 * fleet rather than another slot — so a suite that dispatches in more than one
 * test has to hand the trucks back between them, exactly as it would reset any
 * other external resource it stubs.
 */
export function resetYard(): void {
  board.clear();
}
