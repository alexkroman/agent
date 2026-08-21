/**
 * The concierge's booking world, its dialog stack, and its confirmation gate.
 *
 * **Adapted from LangGraph's customer-support tutorial** (MIT,
 * <https://github.com/langchain-ai/langgraph>,
 * `docs/docs/tutorials/customer-support/customer-support.ipynb`) — the Swiss
 * Airlines support bot. Two things in it are the reason to take its shape
 * rather than invent one, and both land differently over a phone than in a
 * chat window:
 *
 * | customer-support | here |
 * | --- | --- |
 * | `State.dialog_state` (an annotated push/pop stack) | {@link TripState.dialogState} |
 * | `ToFlightBookingAssistant` & friends (delegation tools) | the four tools {@link SPECIALISTS} generates in `routing.ts` |
 * | `CompleteOrEscalate` | `complete_or_escalate`, which pops the same stack |
 * | `interrupt_before=["…_sensitive_tools"]` | {@link stageAction} + `confirm_action` |
 * | `fetch_user_flight_information` (sqlite) | `lookup_booking` over {@link seedTrip} |
 *
 * **The dialog stack is what keeps a long call on the rails.** Their insight is
 * that one prompt holding every tool degrades as the tool list grows, so the
 * primary assistant delegates to a specialist and the specialist works with a
 * narrow brief. A voice agent cannot swap its system prompt mid-session — the
 * session's prompt is fixed at connect — so the specialist's brief arrives as
 * the DELEGATION TOOL'S RESULT, which is the last thing the model reads before
 * it answers. The stack itself is real state either way, which is what
 * `complete_or_escalate` pops and what the sidebar renders.
 *
 * **`interrupt_before` becomes a spoken confirmation, and that is not a
 * downgrade.** Their graph halts before a sensitive tool and waits for a human
 * to approve in the notebook; a caller cannot type "y", but asking out loud and
 * hearing "yes" is the same gate with a better interface. So a sensitive tool
 * never mutates: it STAGES a {@link PendingAction} and returns the sentence the
 * model should read back, and `confirm_action` is the only thing that applies
 * one. The mechanism is worth copying whole — it is the difference between an
 * agent that can rebook a flight and one that can rebook a flight *by mistake*.
 */

import {
  type DeepReadonly,
  derivedFlow,
  pushCapped,
  sessionSlot,
  type ToolFailure,
} from "@alexkroman1/aai";
import { setup } from "xstate";

// ─── The booking world ───────────────────────────────────────────────────────
// Their notebook downloads a sqlite database of a real airline's schedule and
// rewrites its timestamps to "now". A template ships no database, so the world
// is a handful of frozen rows — enough for every tool to return something a
// caller could act on, and small enough to read.

export interface Flight {
  id: string;
  route: string;
  departs: string;
  arrives: string;
  fare: number;
  seatsLeft: number;
}

export interface Hotel {
  id: string;
  name: string;
  city: string;
  area: string;
  pricePerNight: number;
  stars: number;
}

export interface CarRental {
  id: string;
  vendor: string;
  city: string;
  tier: string;
  pricePerDay: number;
}

export interface Excursion {
  id: string;
  name: string;
  city: string;
  kind: string;
  price: number;
}

export const FLIGHTS: Flight[] = [
  {
    id: "LX40",
    route: "Zurich to Boston",
    departs: "Tue 13:05",
    arrives: "Tue 15:45",
    fare: 640,
    seatsLeft: 9,
  },
  {
    id: "LX52",
    route: "Zurich to Boston",
    departs: "Wed 09:20",
    arrives: "Wed 12:05",
    fare: 590,
    seatsLeft: 2,
  },
  {
    id: "LX54",
    route: "Zurich to Boston",
    departs: "Thu 17:40",
    arrives: "Thu 20:25",
    fare: 505,
    seatsLeft: 21,
  },
  {
    id: "LX15",
    route: "Boston to Zurich",
    departs: "Sun 21:15",
    arrives: "Mon 10:40",
    fare: 615,
    seatsLeft: 6,
  },
  {
    id: "LX17",
    route: "Boston to Zurich",
    departs: "Mon 19:55",
    arrives: "Tue 09:30",
    fare: 700,
    seatsLeft: 14,
  },
];

export const HOTELS: Hotel[] = [
  {
    id: "H1",
    name: "Harborview Suites",
    city: "Boston",
    area: "Seaport",
    pricePerNight: 265,
    stars: 4,
  },
  {
    id: "H2",
    name: "The Back Bay",
    city: "Boston",
    area: "Back Bay",
    pricePerNight: 340,
    stars: 5,
  },
  {
    id: "H3",
    name: "Cambridge Rooms",
    city: "Boston",
    area: "Cambridge",
    pricePerNight: 180,
    stars: 3,
  },
  {
    id: "H4",
    name: "Limmat Riverside",
    city: "Zurich",
    area: "Old Town",
    pricePerNight: 295,
    stars: 4,
  },
];

export const CAR_RENTALS: CarRental[] = [
  { id: "C1", vendor: "Alpine Rentals", city: "Boston", tier: "compact", pricePerDay: 48 },
  { id: "C2", vendor: "Alpine Rentals", city: "Boston", tier: "midsize", pricePerDay: 62 },
  { id: "C3", vendor: "Harbor Auto", city: "Boston", tier: "suv", pricePerDay: 95 },
  { id: "C4", vendor: "Limmat Cars", city: "Zurich", tier: "compact", pricePerDay: 54 },
];

export const EXCURSIONS: Excursion[] = [
  { id: "E1", name: "Freedom Trail walk", city: "Boston", kind: "walking tour", price: 35 },
  { id: "E2", name: "Harbor sunset sail", city: "Boston", kind: "boat", price: 78 },
  { id: "E3", name: "North End food crawl", city: "Boston", kind: "food", price: 95 },
  { id: "E4", name: "Lake Zurich cruise", city: "Zurich", kind: "boat", price: 52 },
];

/** `$1,234` — one money format, so a spoken price and a rendered one agree. */
export function formatPrice(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

// ─── The dialog stack ────────────────────────────────────────────────────────

export const SPECIALIST_IDS = ["flight", "hotel", "car_rental", "excursion"] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

/** Who is holding the call. `"primary"` is the host assistant — their
 *  `dialog_state` bottom, reached by popping everything else off. */
export type DialogState = "primary" | SpecialistId;

/**
 * One specialist's brief, handed back as the delegation tool's RESULT.
 *
 * The instructions are adapted from the four `…_prompt` templates in the
 * notebook, compressed for a phone: theirs end in a paragraph about not making
 * up tools, which a chat model needs and a voice model has no room for. What is
 * kept verbatim in spirit is the part that does the work — search persistently,
 * confirm the details back, and escalate rather than improvise.
 */
export interface Specialist {
  /** What the caller hears this desk called. */
  title: string;
  /** The brief the model is handed on delegation. */
  instructions: string;
}

export const SPECIALISTS: Record<SpecialistId, Specialist> = {
  flight: {
    title: "flight desk",
    instructions: [
      "You are now the flight desk. Handle searching and changing flights only.",
      "Search before you quote anything, and be persistent: if the first search",
      "finds nothing, widen it rather than telling the caller there is nothing.",
      "Read the flight number, the day, the departure time and the fare change",
      "back to the caller before you change a ticket. A ticket is only changed",
      "once confirm_action has run.",
      "If the caller wants a hotel, a car or something to do, or changes their",
      "mind, call complete_or_escalate instead of improvising.",
    ].join(" "),
  },
  hotel: {
    title: "hotel desk",
    instructions: [
      "You are now the hotel desk. Handle searching and booking hotels only.",
      "Ask which city and roughly what budget, then search. Offer at most three",
      "options out loud, cheapest first, with the neighbourhood and nightly rate.",
      "Confirm the hotel, the number of nights and the total before booking.",
      "A room is only held once confirm_action has run.",
      "If the caller wants flights, a car or an excursion, call",
      "complete_or_escalate.",
    ].join(" "),
  },
  car_rental: {
    title: "car rental desk",
    instructions: [
      "You are now the car rental desk. Handle searching and booking cars only.",
      "Ask the city and how many days, then search. Name the vendor, the tier",
      "and the daily rate, and confirm the total before booking.",
      "A car is only reserved once confirm_action has run.",
      "If the caller wants flights, a hotel or an excursion, call",
      "complete_or_escalate.",
    ].join(" "),
  },
  excursion: {
    title: "excursions desk",
    instructions: [
      "You are now the excursions desk. Handle recommending and booking things",
      "to do only. Ask the city and what kind of thing they enjoy, then search.",
      "Describe two or three options in a sentence each — this is the part of",
      "the call a caller actually wants to hear about.",
      "A booking is only made once confirm_action has run.",
      "If the caller wants flights, a hotel or a car, call complete_or_escalate.",
    ].join(" "),
  },
};

// ─── Session state ───────────────────────────────────────────────────────────

/** A confirmed booking, as the itinerary carries it. */
export interface BookingRecord {
  kind: "flight" | "hotel" | "car" | "excursion";
  reference: string;
  summary: string;
  price: number;
}

/**
 * A sensitive action that has been described to the caller and not yet applied.
 *
 * A discriminated union rather than a stored closure: the whole point is that
 * the staged action is INSPECTABLE — `confirm_action` re-derives the effect
 * from it, the projection renders it in the sidebar, and a spec can assert on
 * it. A closure would be none of those things.
 */
export type PendingAction =
  | { kind: "update_ticket"; flightId: string }
  | { kind: "cancel_ticket" }
  | { kind: "book_hotel"; hotelId: string; nights: number }
  | { kind: "book_car"; carId: string; days: number }
  | { kind: "book_excursion"; excursionId: string };

export interface TripState {
  passenger: string;
  /** The ticket the caller is holding, or `null` once they cancel it. */
  ticket: { reference: string; flightId: string } | null;
  /** Their `dialog_state` stack: `primary` is always the bottom. */
  dialogState: DialogState[];
  /** Staged-but-unconfirmed sensitive action — at most one at a time, which
   *  {@link stageAction} ENFORCES by refusing a second rather than by saying so
   *  here. A concurrent step emitting two sensitive tools is ordinary. */
  pending: PendingAction | null;
  bookings: BookingRecord[];
  /** What has happened on this call, for the sidebar. Capped on append. */
  log: string[];
  bookingCounter: number;
}

/** Growth cap on the call log — it rides in every `syncState` frame. */
export const MAX_LOG_ENTRIES = 40;

/** The caller as the airline already knows them — their
 *  `fetch_user_flight_information`, minus the sqlite. */
export function seedTrip(): TripState {
  return {
    passenger: "Nadia Rossi",
    ticket: { reference: "QZ7F2K", flightId: "LX40" },
    dialogState: ["primary"],
    pending: null,
    bookings: [],
    log: [],
    bookingCounter: 0,
  };
}

/**
 * The call's state, as one typed slot.
 *
 * `after` holds the one invariant nothing else should have to remember: the
 * stack always has `primary` at the bottom, so a `complete_or_escalate` that
 * pops one too many cannot leave the session with no assistant at all.
 */
export const tripSlot = sessionSlot("trip", seedTrip, {
  after: (state) => {
    if (state.dialogState.length === 0) state.dialogState.push("primary");
  },
});

/**
 * The call as a READ hands it out: deep-frozen, and typed to say so.
 *
 * The pure helpers below take this rather than {@link TripState}, which is the
 * widening a deep-readonly slot forces and the reason it is worth doing: a
 * mutable state still satisfies it, so every `updateTool` draft passes
 * unchanged, while a helper that WOULD have mutated stops compiling instead of
 * throwing at its first call.
 */
export type FrozenTripState = DeepReadonly<TripState>;

export function activeAssistant(state: FrozenTripState): DialogState {
  return state.dialogState.at(-1) ?? "primary";
}

export function note(state: TripState, entry: string): void {
  pushCapped(state.log, entry, MAX_LOG_ENTRIES);
}

// ─── The confirmation gate ───────────────────────────────────────────────────

/**
 * The gate as a MACHINE — their `interrupt_before`, which is a graph construct.
 *
 * This port had to hand-roll it: a voice session had no graph, so "halt before a
 * sensitive tool and resume on approval" became "every sensitive tool STAGES and
 * `confirm_action` is the only thing that applies one". That half is unchanged
 * and is still the mechanism — see {@link stageAction}. What the machine adds is
 * the PRECONDITION on the other side of the halt: `confirm_action` and
 * `cancel_action` are legal only while something is actually waiting, which was
 * a null check inside each of them and is now `when`.
 *
 * **The staging tools are deliberately NOT gated on `browsing`.**
 * {@link stageAction}'s refusal NAMES the sentence already waiting, which is what
 * lets the model settle that one first and restage the rest; a state gate can
 * only say "you are in awaitingConfirmation", since a state's instruction is
 * static. So the specific refusal stays where it is and the flow follows it.
 */
const gateMachine = setup({}).createMachine({
  id: "gate",
  initial: "browsing",
  states: {
    browsing: {
      meta: {
        instruction:
          "Nothing is waiting for the caller's yes. Stage a change with a booking tool first.",
      },
      // The transitions are for a READER and a visualizer: a derived flow's
      // position comes from `pending`, so these document the two edges that
      // field can take rather than enforcing them.
      on: { STAGED: "awaitingConfirmation" },
    },
    awaitingConfirmation: {
      meta: {
        instruction:
          "Read the staged change back and hear a clear yes or no, then use confirm_action or cancel_action.",
      },
      on: { SETTLED: "browsing" },
    },
  },
});

/**
 * Whether a change is waiting on the caller's word — DERIVED from the trip.
 *
 * There is nothing here to keep in step. `pending` IS the gate: a staged action
 * is a change awaiting a yes, and no staged action is not one, so the position
 * is that field read through the machine's vocabulary rather than a second value
 * beside it.
 *
 * It used to be a `flow()` with its own slot, and the seam it removed is the one
 * worth naming: {@link stageAction} had to send `STAGED` in the same synchronous
 * window it wrote `pending` in, and the two settling tools had to remember
 * `SETTLED`. Three places had to agree, each of them correct, and the
 * "reachable only if the position and the payload disagree" arms below existed
 * because nothing enforced that they did. A derived position cannot disagree
 * with the field it is computed from.
 */
export const gateFlow = derivedFlow(gateMachine, tripSlot, (trip) =>
  trip.pending ? "awaitingConfirmation" : "browsing",
);

/**
 * Describe a staged action in one sentence, in the second person — this is
 * read aloud, so it is a question's worth of text and not a receipt.
 */
export function describeAction(action: DeepReadonly<PendingAction>): string | ToolFailure {
  switch (action.kind) {
    case "update_ticket": {
      const flight = FLIGHTS.find((f) => f.id === action.flightId);
      if (!flight) return { error: `No flight ${action.flightId} in the schedule.` };
      return `move your ticket to ${flight.id}, ${flight.route}, departing ${flight.departs}, at ${formatPrice(flight.fare)}`;
    }
    case "cancel_ticket":
      return "cancel your ticket entirely";
    case "book_hotel": {
      const hotel = HOTELS.find((h) => h.id === action.hotelId);
      if (!hotel) return { error: `No hotel ${action.hotelId}.` };
      return `book ${hotel.name} in ${hotel.area} for ${action.nights} night${action.nights === 1 ? "" : "s"}, ${formatPrice(hotel.pricePerNight * action.nights)} total`;
    }
    case "book_car": {
      const car = CAR_RENTALS.find((c) => c.id === action.carId);
      if (!car) return { error: `No car ${action.carId}.` };
      return `reserve the ${car.tier} from ${car.vendor} for ${action.days} day${action.days === 1 ? "" : "s"}, ${formatPrice(car.pricePerDay * action.days)} total`;
    }
    case "book_excursion": {
      const excursion = EXCURSIONS.find((e) => e.id === action.excursionId);
      if (!excursion) return { error: `No excursion ${action.excursionId}.` };
      return `book ${excursion.name} at ${formatPrice(excursion.price)}`;
    }
    // Unreachable while `PendingAction` is exhausted above — and the arm a new
    // member of the union lands in until it has one of its own, which is a
    // refusal rather than an unexplained sentence read down a phone.
    default:
      return { error: "That change cannot be described, so it will not be staged." };
  }
}

/**
 * Stage a sensitive action and return what a sensitive tool answers with.
 *
 * Every sensitive tool ends in this call and none of them mutate anything —
 * that is the whole gate, and keeping it to one helper is what stops the next
 * sensitive tool from being the one that forgets it.
 *
 * **It REFUSES a second staging, and that is the enforcement half of
 * {@link TripState.pending}'s "at most one at a time".** The LLM loop runs a
 * step's tool calls CONCURRENTLY, so two sensitive tools in one step is an
 * ordinary outcome — the model says "change my flight and book the hotel" and
 * emits both. An unconditional assignment made the second win: both tools
 * answered `awaitingConfirmation`, the model read both back, the caller said
 * yes, and `confirm_action` applied ONE of them with nothing anywhere saying
 * the other had been dropped. A gate whose failure is a silent no-op is not a
 * gate. Refusing names the sentence already waiting, which is what lets the
 * model ask about that one first and restage the rest afterwards.
 */
export function stageAction(
  state: TripState,
  action: PendingAction,
):
  | { awaitingConfirmation: true; readBack: string; expires: "on the caller's next answer" }
  | ToolFailure {
  const described = describeAction(action);
  if (typeof described !== "string") return described;
  const waiting = state.pending ? describeAction(state.pending) : null;
  if (waiting !== null) {
    return {
      error:
        `Something is already waiting for the caller's yes: ${typeof waiting === "string" ? waiting : state.pending?.kind}. ` +
        "Settle it with confirm_action or cancel_action, then ask for this one. " +
        "Only one change can be waiting at a time — nothing about this request has been staged.",
    };
  }
  // This write IS the transition: `gateFlow` reads `pending`, so the position is
  // `awaitingConfirmation` from here on with nothing else to send.
  state.pending = action;
  note(state, `Awaiting confirmation: ${described}`);
  return {
    awaitingConfirmation: true,
    readBack: `Ask the caller to confirm, out loud, that they want to ${described}. Nothing has changed yet.`,
    expires: "on the caller's next answer",
  };
}

/**
 * Apply the staged action. The ONE place any of them takes effect.
 *
 * The "nothing is waiting" guard is gone: `confirm_action` is gated on
 * `awaitingConfirmation`, so reaching here means something IS staged. The
 * remaining `!action` arm is the flow and the payload disagreeing, which one
 * synchronous window per transition is what rules out — it reports rather than
 * throwing, because a live call is the wrong place to find out.
 */
export function applyPending(
  state: TripState,
): { applied: string; reference?: string } | ToolFailure {
  const action = state.pending;
  if (!action) {
    return { error: "Nothing is staged after all — ask the caller again what they want." };
  }
  const described = describeAction(action);
  if (typeof described !== "string") return described;
  state.pending = null;
  state.bookingCounter++;
  const reference = `BK${String(1000 + state.bookingCounter)}`;

  switch (action.kind) {
    case "update_ticket": {
      const flight = FLIGHTS.find((f) => f.id === action.flightId);
      if (!flight) return { error: `No flight ${action.flightId}.` };
      if (flight.seatsLeft <= 0) return { error: `${flight.id} has no seats left.` };
      if (!state.ticket) return { error: "There is no ticket to move — it was cancelled." };
      state.ticket = { reference: state.ticket.reference, flightId: flight.id };
      note(state, `Ticket ${state.ticket.reference} moved to ${flight.id}`);
      return { applied: `Ticket moved to ${flight.id}, ${flight.departs}.` };
    }
    case "cancel_ticket": {
      if (!state.ticket) return { error: "There is no ticket to cancel." };
      const cancelled = state.ticket.reference;
      state.ticket = null;
      note(state, `Ticket ${cancelled} cancelled`);
      return { applied: `Ticket ${cancelled} cancelled.` };
    }
    case "book_hotel": {
      const hotel = HOTELS.find((h) => h.id === action.hotelId);
      if (!hotel) return { error: `No hotel ${action.hotelId}.` };
      const price = hotel.pricePerNight * action.nights;
      state.bookings.push({
        kind: "hotel",
        reference,
        summary: `${hotel.name} (${hotel.area}), ${action.nights} night${action.nights === 1 ? "" : "s"}`,
        price,
      });
      note(state, `Hotel booked: ${hotel.name} — ${reference}`);
      return { applied: `${hotel.name} booked, ${formatPrice(price)}.`, reference };
    }
    case "book_car": {
      const car = CAR_RENTALS.find((c) => c.id === action.carId);
      if (!car) return { error: `No car ${action.carId}.` };
      const price = car.pricePerDay * action.days;
      state.bookings.push({
        kind: "car",
        reference,
        summary: `${car.vendor} ${car.tier}, ${action.days} day${action.days === 1 ? "" : "s"}`,
        price,
      });
      note(state, `Car reserved: ${car.vendor} ${car.tier} — ${reference}`);
      return {
        applied: `${car.tier} from ${car.vendor} reserved, ${formatPrice(price)}.`,
        reference,
      };
    }
    case "book_excursion": {
      const excursion = EXCURSIONS.find((e) => e.id === action.excursionId);
      if (!excursion) return { error: `No excursion ${action.excursionId}.` };
      state.bookings.push({
        kind: "excursion",
        reference,
        summary: `${excursion.name} (${excursion.city})`,
        price: excursion.price,
      });
      note(state, `Excursion booked: ${excursion.name} — ${reference}`);
      return { applied: `${excursion.name} booked, ${formatPrice(excursion.price)}.`, reference };
    }
    // Same as `describeAction`: unreachable today, and a refusal rather than a
    // silent no-op for whatever the union grows next.
    default:
      return { error: "That change has no handler, so nothing was applied." };
  }
}

// ─── The projection ──────────────────────────────────────────────────────────

export interface TripView {
  passenger: string;
  /** Which desk is holding the call — the stack's top, rendered as a badge. */
  assistant: DialogState;
  assistantTitle: string;
  ticket: { reference: string; flightId: string; route: string; departs: string } | null;
  bookings: readonly DeepReadonly<BookingRecord>[];
  total: number;
  /** The staged action's sentence, so the browser shows what voice just asked. */
  pending: string | null;
  log: readonly string[];
}

/**
 * What the browser sees. A projection rather than the raw state, for the reason
 * `syncState` takes one: the caller's ticket reference is theirs, the staged
 * action has to be rendered as PROSE rather than as a union the client would
 * have to re-switch on, and the stack top is the one field the sidebar is
 * actually built around.
 */
export function tripView(state: FrozenTripState): TripView {
  const assistant = activeAssistant(state);
  const flight = state.ticket ? FLIGHTS.find((f) => f.id === state.ticket?.flightId) : undefined;
  const described = state.pending ? describeAction(state.pending) : null;
  return {
    passenger: state.passenger,
    assistant,
    assistantTitle: assistant === "primary" ? "concierge" : SPECIALISTS[assistant].title,
    ticket:
      state.ticket && flight
        ? {
            reference: state.ticket.reference,
            flightId: flight.id,
            route: flight.route,
            departs: flight.departs,
          }
        : null,
    bookings: state.bookings,
    total: state.bookings.reduce((sum, b) => sum + b.price, 0),
    pending: typeof described === "string" ? described : null,
    log: state.log,
  };
}

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const tripProjection = tripSlot.projection(tripView);
