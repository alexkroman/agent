/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { SessionEventHandler, ToolContext } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import {
  createToolContext,
  expectDialogOk,
  expectDialogRefused,
  expectToolOk,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

import {
  activeAssistant,
  departureClock,
  FLIGHTS,
  type Flight,
  gateFlow,
  LOG_CAP,
  type SpecialistId,
  tripProjection,
  tripSlot,
  tripView,
} from "./shared.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** A tool by the name the model calls it by, bound to this agent. The lookup,
 *  its "no such tool" message and the args-or-context shape are all
 *  `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which
 *  agent it runs against. */
const run = toolRunner(agentDef);

/** The state a tool just mutated, read back the way `syncState` reads it. */
function stateOf(ctx: ToolContext) {
  return tripSlot.get(ctx);
}

/**
 * Put the call at a desk the way the model has to: through that desk's own
 * delegation tool.
 *
 * Every desk tool checks the stack first (`requireDesk`) and refuses from
 * anywhere else, so a spec driving one has to stand where the model would. It is
 * one line per test rather than a shared `beforeEach` deliberately — which desk
 * a tool belongs to is what the block below is about, so it stays visible at the
 * call site.
 */
const atDesk = async (id: SpecialistId, ctx: ToolContext): Promise<void> => {
  await run(`to_${id}_assistant`, { request: "what the caller asked for" }, ctx);
};

// ─── 1. The dialog stack ─────────────────────────────────────────────────────

describe("dialog stack (routing.ts)", () => {
  test("delegating pushes a desk and hands back its brief", async () => {
    const ctx = createToolContext();
    expect(activeAssistant(stateOf(ctx))).toBe("primary");

    const handoff = (await run(
      "to_hotel_assistant",
      { request: "somewhere near the water" },
      ctx,
    )) as {
      desk: string;
      instructions: string;
    };
    expect(handoff.desk).toBe("hotel desk");
    // The brief IS the tool result — that is the whole port of their
    // per-assistant prompt onto a session whose prompt is fixed at connect.
    expect(handoff.instructions).toContain("hotel desk");
    expect(activeAssistant(stateOf(ctx))).toBe("hotel");
  });

  test("re-delegating to the desk already holding the call does not grow the stack", async () => {
    const ctx = createToolContext();
    await run("to_flight_assistant", { request: "move my flight" }, ctx);
    await run("to_flight_assistant", { request: "actually a later one" }, ctx);
    expect(stateOf(ctx).dialogState).toEqual(["primary", "flight"]);
  });

  test("complete_or_escalate pops, and never past the concierge", async () => {
    const ctx = createToolContext();
    await run("to_excursion_assistant", { request: "something to do" }, ctx);

    const back = (await run("complete_or_escalate", { reason: "booked it" }, ctx)) as {
      returnedFrom: string;
      nowHandling: string;
    };
    expect(back.returnedFrom).toBe("excursions desk");
    expect(back.nowHandling).toBe("concierge");
    expect(activeAssistant(stateOf(ctx))).toBe("primary");

    // Popping again at the bottom is a no-op rather than an empty stack: the
    // slot's `after` hook is what guarantees there is always an assistant.
    await run("complete_or_escalate", { reason: "nothing else" }, ctx);
    expect(stateOf(ctx).dialogState).toEqual(["primary"]);
  });
});

// ─── 1b. The desk gate ───────────────────────────────────────────────────────
//
// What their graph gets from binding a tool set per node, and what this port
// used to only ask the prompt for. The eval (`agent.eval.test.ts`) is what
// measured the asking losing — 0 of 5 live runs, the model searching hotels
// while the stack said `primary` — so these are the tests that make the stack
// binding rather than descriptive.

describe("the desk gate (requireDesk)", () => {
  const DESK_TOOLS = [
    ["search_flights", { route: "Boston" }, "flight"],
    ["update_ticket", { flightId: "LX52" }, "flight"],
    ["cancel_ticket", {}, "flight"],
    ["search_hotels", { city: "Boston" }, "hotel"],
    ["book_hotel", { hotelId: "H1", nights: 2 }, "hotel"],
    ["search_car_rentals", { city: "Boston" }, "car_rental"],
    ["book_car_rental", { carId: "C2", days: 3 }, "car_rental"],
    ["search_excursions", { city: "Boston" }, "excursion"],
    ["book_excursion", { excursionId: "E2" }, "excursion"],
  ] as const;

  test.each(DESK_TOOLS)("%s refuses at the concierge desk", async (name, args, desk) => {
    const ctx = createToolContext();
    const refused = (await run(name, args, ctx)) as { error?: string };
    // The refusal NAMES the way in, which is what the model recovers from
    // inside the same turn — a bare "not allowed" would leave it guessing.
    expect(refused.error).toContain(`to_${desk}_assistant`);
    // And nothing happened: no search result, no staging, no stack movement.
    expect(stateOf(ctx).pending).toBeNull();
    expect(activeAssistant(stateOf(ctx))).toBe("primary");
    expect(gateFlow.position(ctx).state).toBe("browsing");
  });

  test.each(DESK_TOOLS)("%s refuses from ANOTHER desk", async (name, args, desk) => {
    const ctx = createToolContext();
    // The excursions desk for anything that is not its own, and the flight desk
    // for the excursion tools — so every case really is a wrong desk rather
    // than a coincidence of ordering.
    const wrong = desk === "excursion" ? "flight" : "excursion";
    await atDesk(wrong, ctx);
    const refused = (await run(name, args, ctx)) as { error?: string };
    expect(refused.error).toContain(`to_${desk}_assistant`);
    expect(refused.error).toContain(desk === "excursion" ? "flight desk" : "excursions desk");
    expect(stateOf(ctx).pending).toBeNull();
  });

  test.each(DESK_TOOLS)("%s works once its own desk holds the call", async (name, args, desk) => {
    // The other half, and the one that makes the block above non-vacuous: a
    // gate that refused everywhere would pass every assertion up to here.
    const ctx = createToolContext();
    await atDesk(desk, ctx);
    expect(await run(name, args, ctx)).not.toMatchObject({
      error: expect.stringContaining("belongs to the"),
    });
  });

  test("the concierge's own tools are NOT gated", async () => {
    // `lookup_booking` is the concierge's, and the gate must not make the desk
    // unable to answer "what am I holding?" from wherever the call is.
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    const booking = (await run("lookup_booking", ctx)) as { passenger: string };
    expect(booking.passenger).toBe("Nadia Rossi");
  });
});

// ─── 2. The confirmation gate ────────────────────────────────────────────────
//
// Their graph halts before a sensitive tool (`interrupt_before`) and resumes on
// approval. Here every sensitive tool stages and applies nothing, so the
// approval has somewhere to arrive. These are the tests that matter: a
// regression makes the agent able to rebook a flight BY MISTAKE.

describe("sensitive tools stage rather than act", () => {
  test.each([
    ["update_ticket", { flightId: "LX52" }, "flight"],
    ["cancel_ticket", {}, "flight"],
    ["book_hotel", { hotelId: "H1", nights: 2 }, "hotel"],
    ["book_car_rental", { carId: "C2", days: 3 }, "car_rental"],
    ["book_excursion", { excursionId: "E2" }, "excursion"],
  ] as const)("%s changes nothing on its own", async (name, args, desk) => {
    const ctx = createToolContext();
    await atDesk(desk, ctx);
    const before = structuredClone(stateOf(ctx));

    const staged = (await run(name, args, ctx)) as { awaitingConfirmation: boolean };
    expect(staged.awaitingConfirmation).toBe(true);

    const after = stateOf(ctx);
    expect(after.ticket).toEqual(before.ticket);
    expect(after.bookings).toEqual([]);
    expect(after.pending).not.toBeNull();
  });

  test("confirm_action applies the staged change, and only then", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    await run("book_hotel", { hotelId: "H1", nights: 3 }, ctx);

    // Staging moved the gate, in the same window it wrote `pending`.
    expect(gateFlow.position(ctx).state).toBe("awaitingConfirmation");

    // A gated tool answers the flow's POSITION wrapped around the body's own
    // return value, so the applied sentence is under `result`. `expectDialogOk`
    // keeps the position and THROWS on a refusal, quoting it — where the cast
    // it replaces read `undefined` off the failure and died three assertions
    // later on a property of undefined.
    const confirmed = expectDialogOk<{ applied: string; reference: string }>(
      await run("confirm_action", ctx),
    );
    expect(confirmed.result.applied).toContain("Harborview Suites");
    // 3 nights at $265.
    expect(confirmed.result.applied).toContain("$795");
    // SETTLED: the gate re-armed as part of the same call.
    expect(confirmed.state).toBe("browsing");

    const state = stateOf(ctx);
    expect(state.pending).toBeNull();
    expect(state.bookings).toHaveLength(1);
    expect(state.bookings[0]?.reference).toBe(confirmed.result.reference);

    // The gate re-arms, and now REFUSES rather than reporting an empty apply —
    // `when: "awaitingConfirmation"` is what a second confirm meets.
    //
    // `expectDialogRefused` rather than a regex for the sentence: the refusal is
    // the SDK's, written in one place and matched from another, and it throws on
    // a call that SUCCEEDED — where a `toMatchObject` on a success reads
    // `undefined` for `error` and passes nothing worth reading. The state is
    // pinned too, because "refused" and "refused where the spec thinks the
    // conversation is" are two claims.
    expectDialogRefused(await run("confirm_action", ctx), "browsing");
  });

  test("cancel_action drops the staged change and leaves the booking alone", async () => {
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    await run("update_ticket", { flightId: "LX54" }, ctx);
    const dropped = expectDialogOk<{ discarded: string }>(await run("cancel_action", ctx));
    expect(dropped.result.discarded).toContain("LX54");
    expect(dropped.state).toBe("browsing");

    const state = stateOf(ctx);
    expect(state.pending).toBeNull();
    expect(state.ticket?.flightId).toBe("LX40");
    expectDialogRefused(await run("cancel_action", ctx), "browsing");
  });

  test("a staged action naming something that does not exist is refused at staging time", async () => {
    // Refused where the model can still recover — before the caller is asked to
    // confirm a flight the airline does not fly.
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    expect(await run("update_ticket", { flightId: "ZZ99" }, ctx)).toEqual({
      error: "No flight ZZ99 in the schedule.",
    });
    expect(stateOf(ctx).pending).toBeNull();
  });

  test("cancelling the ticket makes a later ticket change impossible", async () => {
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    await run("cancel_ticket", ctx);
    await run("confirm_action", ctx);
    expect(stateOf(ctx).ticket).toBeNull();

    expect(await run("update_ticket", { flightId: "LX52" }, ctx)).toEqual({
      error: "This caller has no ticket to move — it was cancelled on this call.",
    });
    expect(await run("cancel_ticket", ctx)).toEqual({ error: "There is no ticket to cancel." });
  });

  test("a second staging is REFUSED rather than overwriting the first", async () => {
    // The LLM loop runs a step's tool calls concurrently, so two sensitive
    // tools in one step is ordinary: the model hears "move my flight and cancel
    // the old one" and emits both. Assigning `pending` unconditionally made the
    // second win — both answered `awaitingConfirmation`, the caller said yes
    // once, and one of the two changes was silently dropped forever.
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    const first = (await run("update_ticket", { flightId: "LX52" }, ctx)) as {
      awaitingConfirmation: boolean;
    };
    expect(first.awaitingConfirmation).toBe(true);

    // Both from ONE desk, which is what a concurrent pair looks like now that
    // `requireDesk` is enforced. Another desk's tool would be refused by the
    // DESK gate first, which is a different refusal and would leave this one
    // unexercised.
    const second = (await run("cancel_ticket", ctx)) as {
      error: string;
    };
    // The refusal NAMES what is already waiting, which is what lets the model
    // settle that one and come back rather than guess.
    expect(second.error).toContain("LX52");
    expect(second.error).toMatch(/confirm_action or cancel_action/);

    // The first staging is untouched, and it is what a yes applies.
    expect(stateOf(ctx).pending).toEqual({ kind: "update_ticket", flightId: "LX52" });
    // A refused SECOND staging must not have moved the gate either — it was
    // already `awaitingConfirmation` and the refusal changed nothing.
    expect(gateFlow.position(ctx).state).toBe("awaitingConfirmation");
    // `expectToolOk` is `expectDialogOk` with `.result` taken off: this assertion is about
    // what the apply DID, not about where the gate landed.
    const applied = expectToolOk<{ applied: string }>(await run("confirm_action", ctx));
    expect(applied.applied).toContain("LX52");
    expect(stateOf(ctx).bookings).toEqual([]);

    // Once the queue is clear, the next desk's booking can be staged after all.
    await atDesk("hotel", ctx);
    const retried = (await run("book_hotel", { hotelId: "H1", nights: 2 }, ctx)) as {
      awaitingConfirmation: boolean;
    };
    expect(retried.awaitingConfirmation).toBe(true);
  });

  test("cancel_action clears the block, so a declined change does not wedge the desk", async () => {
    const ctx = createToolContext();
    await atDesk("car_rental", ctx);
    await run("book_car_rental", { carId: "C2", days: 3 }, ctx);
    await run("cancel_action", ctx);
    await atDesk("excursion", ctx);
    const staged = (await run("book_excursion", { excursionId: "E2" }, ctx)) as {
      awaitingConfirmation: boolean;
    };
    expect(staged.awaitingConfirmation).toBe(true);
  });

  test("two independent contexts never share a stack, a ticket or an itinerary", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const first = createToolContext();
    const second = createToolContext();

    await run("to_hotel_assistant", { request: "a room" }, first);
    await run("book_hotel", { hotelId: "H3", nights: 1 }, first);
    await run("confirm_action", first);

    expect(activeAssistant(stateOf(second))).toBe("primary");
    expect(stateOf(second).bookings).toEqual([]);
    // The GATE is per-session too, not just the trip.
    expect(gateFlow.position(second).state).toBe("browsing");
    expectDialogRefused(await run("confirm_action", second), "browsing");
    expect(stateOf(first).bookings).toHaveLength(1);
  });
});

// ─── 3. Search ───────────────────────────────────────────────────────────────

describe("search tools", () => {
  test("an unmatched route widens to the whole schedule rather than answering nothing", async () => {
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    const hit = (await run("search_flights", { route: "Zurich to Boston" }, ctx)) as {
      widened: boolean;
      flights: unknown[];
    };
    expect(hit.widened).toBe(false);
    expect(hit.flights).toHaveLength(3);

    const miss = (await run("search_flights", { route: "Osaka" }, ctx)) as {
      widened: boolean;
      flights: unknown[];
    };
    expect(miss.widened).toBe(true);
    expect(miss.flights).toHaveLength(FLIGHTS.length);
  });

  test("a departure-time floor filters the schedule, and a bad clock is left out", async () => {
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    // 17:40 and 21:15 and 19:55 are at or after 17:00; the two morning
    // departures are not. Compared as STRINGS, which is only legal because
    // every reading is zero-padded — the property `isClockTime` is asked for.
    const evening = (await run("search_flights", { departsAfter: "17:00" }, ctx)) as {
      widened: boolean;
      flights: { flight: string }[];
    };
    expect(evening.widened).toBe(false);
    expect(evening.flights.map((f) => f.flight)).toEqual(["LX54", "LX15", "LX17"]);

    // Nothing that late, so the desk widens to the whole schedule rather than
    // telling the caller there is nothing — the same "be generous" arm the
    // route filter has.
    const midnight = (await run("search_flights", { departsAfter: "23:30" }, ctx)) as {
      widened: boolean;
      flights: unknown[];
    };
    expect(midnight.widened).toBe(true);
    expect(midnight.flights).toHaveLength(FLIGHTS.length);

    // The schedule's own half of the same rule: a row whose departure is not a
    // clock reading has nothing to compare, and `departureClock` says so rather
    // than ordering the caller's request against "Tue".
    expect(departureClock(FLIGHTS[0] as Flight)).toBe("13:05");
    expect(departureClock({ ...(FLIGHTS[0] as Flight), departs: "Tuesday" })).toBeUndefined();
  });

  test("hotels come back cheapest first, and a ceiling filters them", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    const all = (await run("search_hotels", { city: "Boston" }, ctx)) as {
      hotels: { perNight: string }[];
    };
    // Always to the cent: `formatMoney` is one shape at every desk, where
    // this template's own `toLocaleString` copy dropped `.00` on a round
    // number and kept it on a price with change.
    expect(all.hotels.map((h) => h.perNight)).toEqual(["$179.95", "$265.00", "$340.00"]);

    const cheap = (await run("search_hotels", { city: "Boston", maxPerNight: 200 }, ctx)) as {
      hotels: { name: string }[];
    };
    expect(cheap.hotels).toHaveLength(1);
    expect(cheap.hotels[0]?.name).toBe("Cambridge Rooms");
  });

  test("an excursion keyword that matches nothing falls back to the city", async () => {
    const ctx = createToolContext();
    await atDesk("excursion", ctx);
    const result = (await run("search_excursions", { city: "Boston", keyword: "skiing" }, ctx)) as {
      widened: boolean;
      excursions: unknown[];
    };
    expect(result.widened).toBe(true);
    expect(result.excursions).toHaveLength(3);
  });

  test("lookup_booking reports the ticket the caller is actually holding", async () => {
    const ctx = createToolContext();
    await atDesk("flight", ctx);
    await run("update_ticket", { flightId: "LX52" }, ctx);
    await run("confirm_action", ctx);
    const booking = (await run("lookup_booking", ctx)) as {
      passenger: string;
      ticket: { flight: string; departs: string } | null;
    };
    expect(booking.passenger).toBe("Nadia Rossi");
    expect(booking.ticket?.flight).toBe("LX52");
    expect(booking.ticket?.departs).toBe("Wed 09:20");
  });
});

// ─── 4. The projection contract with client.tsx ─────────────────────────────

describe("tripView projection", () => {
  test("an untouched call projects the seeded booking at the concierge desk", () => {
    // Exactly the frame `client.tsx` renders before the first push — it passes
    // this same projection to `useAgentState`.
    const view = tripProjection();
    expect(view).toMatchObject({
      assistant: "primary",
      assistantTitle: "concierge",
      bookings: [],
      total: 0,
      pending: null,
    });
    expect(view.ticket?.flightId).toBe("LX40");
  });

  test("renders the staged action as the prose the concierge just spoke", async () => {
    const ctx = createToolContext();
    await run("to_car_rental_assistant", { request: "a car for the week" }, ctx);
    await run("book_car_rental", { carId: "C3", days: 4 }, ctx);

    const view = tripView(stateOf(ctx));
    expect(view.assistant).toBe("car_rental");
    expect(view.assistantTitle).toBe("car rental desk");
    // $95/day × 4 — the sidebar and the spoken read-back derive from one string.
    expect(view.pending).toContain("$380");
    expect(view.log.at(-1)).toContain("Awaiting confirmation");
  });

  test("totals every confirmed booking, to the cent", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    await run("book_hotel", { hotelId: "H3", nights: 3 }, ctx); // 3 × 179.95
    await run("confirm_action", ctx);
    await atDesk("excursion", ctx);
    await run("book_excursion", { excursionId: "E1" }, ctx); // 35
    await run("confirm_action", ctx);

    const view = tripView(stateOf(ctx));
    // `179.95 * 3` is `539.8499999999999`, so this is the assertion `roundMoney`
    // is there for: the price is what gets STORED and then summed, and a
    // booking that carries the dust makes every later comparison a coin toss.
    // It would print as $539.85 either way, which is what hides it.
    expect(view.bookings[0]?.price).toBe(539.85);
    expect(view.total).toBe(574.85);
    expect(view.bookings.map((b) => b.kind)).toEqual(["hotel", "excursion"]);
    expect(view.pending).toBeNull();
  });
});

describe("the call log", () => {
  test("is capped by the slot, so a long call cannot grow the frame without bound", async () => {
    // The log rides in every `syncState` frame, and it now has writers that are
    // not tool calls at all (`call-events.ts` appends on a reported error), so
    // "how long can this get" is a question with no answer in the tools. The
    // slot's `caps` is the answer, and this is the assertion that it is real.
    const ctx = createToolContext();
    for (let i = 0; i < LOG_CAP + 5; i++) {
      await run("to_flight_assistant", { request: `ask ${i}` }, ctx);
    }
    const log = stateOf(ctx).log;
    expect(log).toHaveLength(LOG_CAP);
    // Capped at the FRONT: what a desk reading the sidebar wants is the end of
    // the call, so the oldest lines are the ones that go.
    expect(log[0]).toContain("ask 5");
    expect(log.at(-1)).toContain(`ask ${LOG_CAP + 4}`);
  });
});

describe("a caller who hangs up", () => {
  /** The frame the runtime offers a declared dialog when a session times out. */
  const CALLER_GONE = { type: "session.timed-out", meta: { id: "evt_1", at: 0 } } as const;

  /**
   * The same event, delivered to the AGENT'S hooks the way the runtime delivers
   * it: the handler declared for the event's own type.
   *
   * The cast is the runtime's own (`session-emitter.ts` makes it once, at the
   * lookup): `events` is typed per key, so a dispatch driven by an event reads
   * its handler back as the union's `SessionEventHandler`. A `ToolContext`
   * stands in for the hook context — a handler is handed `slots` and
   * `sessionId`, which is all `tripSlot.update` needs and deliberately much less
   * than a tool gets.
   */
  const deliver = (event: SessionEvent, ctx: ToolContext): void => {
    const handler = agentDef.events?.[event.type] as SessionEventHandler | undefined;
    // A throw rather than an `expect`: this runs from a helper, and the failure
    // it reports — the agent declares no hook for this event — is a fact about
    // the declaration rather than about the case that called it.
    if (!handler) throw new Error(`no handler is declared for ${event.type}`);
    handler(event, ctx);
  };

  test("ends the call, from a gate that is holding a staged booking", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    await run("book_hotel", { hotelId: "H1", nights: 3 }, ctx);
    expect(gateFlow.position(ctx).state).toBe("awaitingConfirmation");

    const at = gateFlow.receive(ctx, CALLER_GONE);
    expect(at.state).toBe("abandoned");
    expect(at.done).toBe(true);
  });

  test("a sensitive tool cannot run afterwards", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    await run("book_hotel", { hotelId: "H1", nights: 3 }, ctx);
    gateFlow.receive(ctx, CALLER_GONE);

    // The property the state exists for: `confirm_action` is what turns a
    // staged booking into a real one, and nobody is on the call to agree to it.
    //
    // The shape this replaces — `isToolFailure(…)` then a `toContain` guarded by
    // it — lets a SUCCESS through as an assertion that never runs.
    expectDialogRefused(await run("confirm_action", {}, ctx), "abandoned");
  });

  test("the staged action is still THERE — the state is final so nothing reads it", async () => {
    const ctx = createToolContext();
    await atDesk("hotel", ctx);
    await run("book_hotel", { hotelId: "H1", nights: 3 }, ctx);
    gateFlow.receive(ctx, CALLER_GONE);

    // Stated as a test because it is the feature's sharpest limit: a session
    // event SENDS AN EVENT and cannot run a tool, so `pending` is untouched.
    // That is safe here only because `abandoned` is final — the same shape as a
    // timeout returning to `browsing` would strand a staged change in a call
    // that carries on.
    expect(tripSlot.get(ctx).pending).not.toBeNull();
  });

  test("the call log says the caller went, and names what was never applied", () => {
    // The other route the same event takes: the dialog moves the POSITION, and
    // `agent({ events })` writes the LINE. Neither covers the other — a
    // position is not something a desk can read afterwards, and a hook cannot
    // stop `confirm_action` running.
    const ctx = createToolContext();
    tripSlot.update(ctx, (trip) => {
      trip.pending = { kind: "book_hotel", hotelId: "H1", nights: 3 };
    });

    deliver(CALLER_GONE, ctx);

    expect(tripSlot.get(ctx).log.at(-1)).toContain("Caller gone");
    expect(tripSlot.get(ctx).log.at(-1)).toContain("Harborview Suites");
    // A hook records; it does not settle. The staged change is still there,
    // which is the whole reason the line names it.
    expect(tripSlot.get(ctx).pending).not.toBeNull();
  });

  test("with nothing staged it says so, rather than naming an empty change", () => {
    const ctx = createToolContext();
    deliver(CALLER_GONE, ctx);
    expect(tripSlot.get(ctx).log).toEqual(["Caller gone — nothing was waiting."]);
  });

  test("an error on the call is recorded too, fatal or not", () => {
    const ctx = createToolContext();
    const meta = { id: "evt_2", at: 0 };
    // Declared under its own key, so the handler reads `code`, `message` and
    // `fatal` off the event with no narrowing — which is what the map's typed
    // half buys and the reason these are two handlers rather than one `"*"`.
    deliver(
      { type: "error.reported", meta, code: "tts", message: "voice down", fatal: false },
      ctx,
    );
    deliver(
      { type: "error.reported", meta, code: "llm", message: "gateway 503", fatal: true },
      ctx,
    );

    expect(tripSlot.get(ctx).log).toEqual([
      "Trouble on the call (tts): voice down",
      "Call failed (llm): gateway 503",
    ]);
  });
});
