import type { ToolContext, ToolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import { createToolContext, expectDialogOk } from "@alexkroman1/aai/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { roadsideSlot, type Truck } from "./shared.ts";
import acknowledgeDisclosure from "./tools/acknowledge_disclosure.ts";
import dispatchTruck from "./tools/dispatch_truck.ts";
import lookupCoverage from "./tools/lookup_coverage.ts";
import reportLocation from "./tools/report_location.ts";
import { HOLD_MINUTES, reserveTruck, resetYard, yardLock } from "./yard.ts";

/**
 * The yard is the one thing in this template that two calls can fight over, and
 * this file is the fight.
 *
 * Every assertion here fails without the keyed lock in `yard.ts`: the board is
 * read across an `await` and written after it, so two reservations for the same
 * truck kind that are not serialized both see the same free van and both take
 * it. That is the bug the primitive exists for, and it is why these tests drive
 * `Promise.all` rather than one call at a time.
 */

beforeEach(resetYard);

/** The truck, or a failure the desk could not have meant to get. */
function truck(reserved: Truck | ToolFailure): Truck {
  if (isToolFailure(reserved)) throw new Error(`the yard refused: ${reserved.error}`);
  return reserved;
}

const A_LOCATION = {
  where: "eastbound route nine, just past the exit for Millfield",
  safeToWait: true,
  situation: "wont_start",
  make: "Toyota",
  model: "Corolla",
} as const;

/** Walk one call to `onCall.dispatching`, which is where the yard is reached. */
async function toDispatching(ctx: ToolContext): Promise<void> {
  expectDialogOk(await reportLocation.execute(A_LOCATION, ctx));
  expectDialogOk(await lookupCoverage.execute({ policyNumber: "RS-4417" }, ctx));
  expectDialogOk(await acknowledgeDisclosure.execute({ accepted: true }, ctx));
}

describe("the yard hands one truck to one caller", () => {
  test("two calls that both need a van are handed DIFFERENT vans", async () => {
    // Concurrent on purpose: both bodies read the board, yield, and write it
    // back. Unlocked, both read a board with Van-3 free and both return it.
    const [first, second] = await Promise.all([
      reserveTruck("battery", "call-a"),
      reserveTruck("lockout", "call-b"),
    ]);

    expect(truck(first).kind).toBe("service_van");
    expect(truck(second).kind).toBe("service_van");
    expect(truck(second).callsign).not.toBe(truck(first).callsign);
  });

  test("a van caller and a flatbed caller never wait on each other", async () => {
    // Different KEYS, so the lock is not one global mutex — which is the whole
    // difference between `createKeyedLock` and a single promise chain.
    const [van, flatbed] = await Promise.all([
      reserveTruck("lockout", "call-a"),
      reserveTruck("wont_start", "call-b"),
    ]);
    expect(truck(van).callsign).toBe("Van-3");
    expect(truck(flatbed).callsign).toBe("Flat-2");
  });

  test("one call gets one truck, however many times it asks", async () => {
    const first = truck(await reserveTruck("battery", "call-a"));
    const again = truck(await reserveTruck("battery", "call-a"));
    expect(again.callsign).toBe(first.callsign);
  });

  test("a kind with nothing free is a sentence, and the hold lapses in time", async () => {
    const now = Date.UTC(2026, 0, 1, 3, 0);
    // One heavy in the fleet, so the second caller has nowhere to go.
    expect(truck(await reserveTruck("collision", "call-a", { now })).callsign).toBe("Heavy-1");
    const jammed = await reserveTruck("collision", "call-b", { now });
    expect(isToolFailure(jammed) && jammed.error).toMatch(/heavy duty/);

    // A hold is time-boxed rather than swept, so a board entry the yard has
    // stopped expecting back is simply free again.
    const later = now + (HOLD_MINUTES + 1) * 60_000;
    expect(truck(await reserveTruck("collision", "call-b", { now: later })).callsign).toBe(
      "Heavy-1",
    );
  });

  test("a yard that does not answer gives the desk a sentence, not an exception", async () => {
    const release = await yardLock("service_van");
    try {
      const refused = await reserveTruck("battery", "call-a", { wait: { timeoutMs: 5 } });
      // A `KeyedLockTimeoutError` reaching the tool executor mid-call would be
      // an exception down a phone line. What the caller needs is something the
      // model can say, and something that is NOT a callsign or a time.
      expect(isToolFailure(refused) && refused.error).toMatch(/service van/);
      expect(isToolFailure(refused) && refused.error).not.toMatch(/Van-/);
    } finally {
      release();
    }
  });

  test("the lock drops each key once its chain drains", async () => {
    await reserveTruck("battery", "call-a");
    await reserveTruck("collision", "call-b");
    // Two keys were held; a lock that kept an entry per distinct key would grow
    // forever in a process that answers calls all day.
    await expect.poll(() => yardLock.size).toBe(0);
  });
});

describe("dispatch_truck over the yard", () => {
  test("two pinned calls in ONE step roll one truck and log one dispatch", async () => {
    const ctx = createToolContext();
    await toDispatching(ctx);

    // `onCall.dispatching` pins the model to this tool, and the LLM loop runs a
    // step's tool calls concurrently — so both bodies read `job === null`
    // before either writes. The yard's `callKey` hold is what makes them the
    // same truck, and the re-read inside the mutation window is what makes
    // them one job.
    const [one, two] = await Promise.all([
      dispatchTruck.execute({ destination: "Millfield Auto", towMiles: 31 }, ctx),
      dispatchTruck.execute({ destination: "Millfield Auto", towMiles: 31 }, ctx),
    ]);

    const first = expectDialogOk<{ callsign: string; alreadyDispatched: boolean }>(one);
    const second = expectDialogOk<{ callsign: string; alreadyDispatched: boolean }>(two);
    expect(second.result.callsign).toBe(first.result.callsign);
    expect([first.result.alreadyDispatched, second.result.alreadyDispatched]).toEqual([
      false,
      true,
    ]);

    const dispatches = roadsideSlot.get(ctx).log.filter((line) => line.startsWith("Dispatched"));
    expect(dispatches).toHaveLength(1);
  });

  test("a caller whose kind is all out is told so, and no job is written", async () => {
    const busy = createToolContext();
    await toDispatching(busy);

    // Two flatbeds, both taken by other calls before this one asks.
    truck(await reserveTruck("wont_start", "another-call-1"));
    truck(await reserveTruck("wont_start", "another-call-2"));

    const refused = await dispatchTruck.execute({ destination: "shop", towMiles: 4 }, busy);
    expect(isToolFailure(refused) && refused.error).toMatch(/supervisor will call back/);
    expect(roadsideSlot.get(busy).job).toBeNull();
  });
});
