import type { DeepReadonly, ToolFailure } from "@alexkroman1/aai";
import { sessionSlot, spokenAlphanumeric } from "@alexkroman1/aai";

/**
 * The roadside desk's world: the rate cards, the fleet, the one session slot,
 * and the pure functions that turn a coverage record into money and into the
 * words the disclosure is read from.
 *
 * `call.ts` holds the other half — where the CONVERSATION is. The split is the
 * one `retail` draws between `shared.ts` and `store.ts` and it is worth keeping
 * here for a reason specific to this template: everything in this file is a
 * fact about the caller's vehicle, policy and truck, and not one of those is a
 * fact about the call. Per-entity facts live in the slot; the position lives in
 * the dialog. Mixing them is the mistake `dispatch-center`'s guide entry is
 * about, and a file boundary is a cheap way not to make it.
 */

// ─── The rate cards ──────────────────────────────────────────────────────────

/**
 * What a plan charges, per plan.
 *
 * `callOut` is the flat fee for putting a truck on the road, `freeTowMiles` is
 * what the plan tows for nothing, and `perMile` is what every mile after that
 * costs. Both member plans waive the call-out, which is the whole thing the
 * caller is paying an annual membership for and therefore the sentence the
 * disclosure has to get right.
 */
export const PLANS = {
  basic: { name: "Roadside Basic", callOut: 0, freeTowMiles: 5, perMile: 4 },
  plus: { name: "Roadside Plus", callOut: 0, freeTowMiles: 25, perMile: 3 },
} as const;

export type PlanId = keyof typeof PLANS;

/** One plan's numbers, or {@link NON_MEMBER}'s — what {@link quoteFee} prices. */
export type RateCard = (typeof PLANS)[PlanId] | typeof NON_MEMBER;

/**
 * What a caller with no plan we could verify pays.
 *
 * Reached three ways — no policy on file, a lapsed one, and the
 * `onCall.verifying` deadline giving up — and deliberately ONE rate card for
 * all three. The desk does not know which of the three it is looking at by the
 * time it quotes, and a caller quoted a different number depending on why we
 * could not confirm them is the kind of thing a regulator reads out loud.
 */
export const NON_MEMBER = {
  name: "no verified plan",
  callOut: 129,
  freeTowMiles: 0,
  perMile: 7,
} as const;

/**
 * The rate card in force for a coverage record — or for the absence of one.
 *
 * Takes the FROZEN shape, because everything that calls it reads the slot: the
 * template aliases `DeepReadonly` once ({@link FrozenRoadsideState}) and every
 * pure helper over slot state is typed through it. A mutable `Coverage` still
 * satisfies it, so an `update` draft passes unchanged.
 */
export function rateFor(coverage: FrozenRoadsideState["coverage"]): RateCard {
  if (coverage === null || coverage.status === "lapsed") return NON_MEMBER;
  return PLANS[coverage.plan];
}

/**
 * What this call costs the caller, in whole dollars.
 *
 * A PURE function of the rate card and the distance, called from two places
 * that must never disagree: the disclosure the caller hears before the truck
 * moves, and the invoice `dispatch_truck` writes after it does. When those two
 * disagree the second one is a chargeback, so there is exactly one of them.
 */
export function quoteFee(rate: RateCard, towMiles: number): Quote {
  const billableMiles = Math.max(0, Math.ceil(towMiles) - rate.freeTowMiles);
  const mileage = billableMiles * rate.perMile;
  return { callOut: rate.callOut, billableMiles, mileage, total: rate.callOut + mileage };
}

export interface Quote {
  /** The flat fee for rolling a truck at all. */
  callOut: number;
  /** Miles past what the plan covers — what `mileage` is charged for. */
  billableMiles: number;
  /** `billableMiles` at the plan's per-mile rate. */
  mileage: number;
  /** What the caller owes: `callOut + mileage`. */
  total: number;
}

/**
 * The mandatory service-fee disclosure, word for word.
 *
 * This is the text `onCall.disclosure` exists to get said, and it is built here
 * rather than written into the state's `instruction` for two reasons. It varies
 * with the plan, and an instruction is a fixed string. And an instruction is
 * GUIDANCE — the model is supposed to act on it in its own words — where this
 * is a script the model is supposed to read verbatim, which is a different kind
 * of thing and reaches the model a different way: as a tool result
 * (`service_disclosure`) that hands over the exact sentences.
 */
export function disclosureFor(coverage: FrozenRoadsideState["coverage"]): string {
  const rate = rateFor(coverage);
  const cover =
    rate === NON_MEMBER
      ? "We could not confirm an active plan on this vehicle, so this call is billed at our " +
        `non-member rate: a ${money(rate.callOut)} call-out fee, plus ${money(rate.perMile)} ` +
        "for every mile the vehicle is towed."
      : `You are on ${rate.name}. There is no call-out fee, the first ${rate.freeTowMiles} ` +
        `miles of towing are covered, and it is ${money(rate.perMile)} a mile after that.`;
  return (
    `${cover} The fee is charged once the truck is dispatched, whether or not the vehicle ` +
    "starts when the driver arrives, and it is not refunded if you cancel after that point. " +
    "Any repair the driver makes at the roadside is billed separately by the shop."
  );
}

/** Whole dollars, spoken the way a driver would say them. */
export function money(dollars: number): string {
  return `$${dollars}`;
}

// ─── The fleet ───────────────────────────────────────────────────────────────

export type TruckKind = "service_van" | "flatbed" | "heavy_duty";

/** What can go wrong at the roadside, as the caller's own tool argument. */
export const SITUATIONS = [
  "flat_tire",
  "battery",
  "lockout",
  "out_of_fuel",
  "wont_start",
  "collision",
] as const;

export type Situation = (typeof SITUATIONS)[number];

/**
 * What each situation needs on scene.
 *
 * A jump start or a lockout is a van with a driver; a car that will not start
 * goes on a flatbed, and anything that has been hit goes on the heavy. Sending
 * the wrong one is a second call-out an hour later, which is why the caller is
 * never asked to choose — they are asked what happened, and this decides.
 */
export const TRUCK_FOR: Record<Situation, TruckKind> = {
  flat_tire: "service_van",
  battery: "service_van",
  lockout: "service_van",
  out_of_fuel: "service_van",
  wont_start: "flatbed",
  collision: "heavy_duty",
};

export interface Truck {
  callsign: string;
  kind: TruckKind;
  /** Minutes out from the desk's own yard, before any priority bump. */
  minutesOut: number;
}

/** A small fixed fleet, nearest first. A real desk queries a dispatch API here. */
export const FLEET: readonly Truck[] = [
  { callsign: "Van-3", kind: "service_van", minutesOut: 18 },
  { callsign: "Van-7", kind: "service_van", minutesOut: 31 },
  { callsign: "Flat-2", kind: "flatbed", minutesOut: 26 },
  { callsign: "Flat-9", kind: "flatbed", minutesOut: 44 },
  { callsign: "Heavy-1", kind: "heavy_duty", minutesOut: 39 },
];

/** Minutes a caller who is NOT in a safe place is moved up the queue by. */
export const PRIORITY_MINUTES = 8;
/** No promise is ever shorter than this, however the arithmetic comes out. */
export const MIN_ETA_MINUTES = 6;

/** The nearest truck that can do this job, or a failure naming what is out. */
export function assignTruck(situation: Situation): Truck | ToolFailure {
  const kind = TRUCK_FOR[situation];
  const truck = FLEET.find((candidate) => candidate.kind === kind);
  return (
    truck ?? {
      error: `No ${kind} is on the road right now. Tell the caller a supervisor will call back with a time, and do not promise one.`,
    }
  );
}

/** What the caller is told, in minutes — the one number they will hold us to. */
export function etaMinutes(truck: Truck, safeToWait: boolean): number {
  const bumped = safeToWait ? truck.minutesOut : truck.minutesOut - PRIORITY_MINUTES;
  return Math.max(MIN_ETA_MINUTES, bumped);
}

// ─── The policy book ─────────────────────────────────────────────────────────

export interface Coverage {
  policyNumber: string;
  holder: string;
  plan: PlanId;
  status: "active" | "lapsed";
}

/**
 * The policies this demo knows about. A real desk calls a membership service.
 *
 * A lapsed policy is in here on purpose: "we found you and you are not covered"
 * and "we could not find you" are the same PRICE and a different SENTENCE, and
 * a caller who thinks they are covered and is not is the single worst outcome
 * this call has.
 */
const POLICY_BOOK: readonly Coverage[] = [
  { policyNumber: "RS-4417", holder: "Dana Whitfield", plan: "plus", status: "active" },
  { policyNumber: "RS-8802", holder: "Marcus Oyelaran", plan: "basic", status: "active" },
  { policyNumber: "RS-1290", holder: "Priya Raghavan", plan: "plus", status: "lapsed" },
];

/** Look a policy number up, however the caller spelled it out loud. */
export function findPolicy(policyNumber: string): Coverage | undefined {
  const wanted = normalizePolicy(policyNumber);
  return POLICY_BOOK.find((policy) => normalizePolicy(policy.policyNumber) === wanted);
}

/**
 * A policy number as the desk compares them.
 *
 * Callers read these off a card down a phone line, so the hyphen, the spaces
 * and the case are all noise — "r s four four one seven" comes through STT as
 * anything from `RS4417` to `rs 4417`. Comparing the raw string is the version
 * that tells a covered member they have no plan.
 */
function normalizePolicy(policyNumber: string): string {
  return spokenAlphanumeric(policyNumber);
}

// ─── The session's own state ─────────────────────────────────────────────────

export interface Vehicle {
  year: number | null;
  make: string;
  model: string;
  color: string | null;
}

export interface Whereabouts {
  /** Where the caller says they are, in their own words. */
  described: string;
  /** Anything a driver can steer by — a mile marker, an exit, a storefront. */
  landmark: string | null;
  /** Whether they are somewhere they can wait. Decides the priority bump. */
  safeToWait: boolean;
}

export interface TowJob {
  callsign: string;
  kind: TruckKind;
  destination: string;
  towMiles: number;
  etaMinutes: number;
  quote: Quote;
}

export interface RoadsideState {
  vehicle: Vehicle | null;
  where: Whereabouts | null;
  situation: Situation | null;
  /** The plan the lookup found. `null` means unverified, which is a PRICE. */
  coverage: Coverage | null;
  /** When the caller said they understood the disclosure, epoch ms. */
  disclosureAcceptedAt: number | null;
  /** The one truck this call ever assigns. See `dispatch_truck`. */
  job: TowJob | null;
  log: string[];
}

export function emptyRoadsideState(): RoadsideState {
  return {
    vehicle: null,
    where: null,
    situation: null,
    coverage: null,
    disclosureAcceptedAt: null,
    job: null,
    log: [],
  };
}

/**
 * Everything this call has established, as one typed slot.
 *
 * **No `after` hook, and that is a claim rather than an omission.** Nothing
 * stored here is derived from anything else stored here: the money is
 * {@link quoteFee} of the coverage and the distance, computed where it is
 * quoted, and the log is bounded by `caps` — twenty-four lines is enough to
 * read back a whole call. The moment a field IS derived — a running total, a
 * flag some tool reads — it belongs in an `after` hook rather than in whichever
 * tool happened to write last; see `dispatch-center` for the worked version of
 * that.
 */
export const roadsideSlot = sessionSlot("roadside", emptyRoadsideState, { caps: { log: 24 } });

/**
 * The slot as a READ hands it out: deep-frozen, and typed to say so.
 *
 * Every template that reads its slot from a pure helper aliases this once —
 * `slot.get` and a gated read both answer {@link DeepReadonly}, and TypeScript
 * does not ignore `readonly` on arrays, so `readonly string[]` stops satisfying
 * `string[]`. A mutable value still satisfies the alias, so an `update` draft
 * passes unchanged while a helper that WOULD have mutated stops compiling.
 */
export type FrozenRoadsideState = DeepReadonly<RoadsideState>;

/** The vehicle as a driver would be told to look for it. */
export function describeVehicle(vehicle: Vehicle): string {
  return [vehicle.year, vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(" ");
}
