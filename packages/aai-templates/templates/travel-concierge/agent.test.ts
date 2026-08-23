/// <reference types="vite/client" />

import type { ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  ok,
  okPosition,
  toolRunner,
  withDiscoveredTools,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS: it is what a scaffolded project runs, so it may not import
 * anything outside its own template, and `import.meta.glob` is expanded against
 * the file containing it either way. This is the pattern a user writes.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

import {
  activeAssistant,
  FLIGHTS,
  gateFlow,
  tripProjection,
  tripSlot,
  tripView,
} from "./shared.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** Each context owns its OWN slot store, which is what the isolation test
 *  below rests on. */
const makeCtx = (): ToolContext => createToolContext();

/** A tool by the name the model calls it by, bound to this agent. The lookup,
 *  its "no such tool" message and the args-or-context shape are all
 *  `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which
 *  agent it runs against. */
const run = toolRunner(agentDef);

/** The state a tool just mutated, read back the way `syncState` reads it. */
function stateOf(ctx: ToolContext) {
  return tripSlot.get(ctx);
}

// ─── 1. The dialog stack ─────────────────────────────────────────────────────

describe("dialog stack (routing.ts)", () => {
  test("delegating pushes a desk and hands back its brief", async () => {
    const ctx = makeCtx();
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
    const ctx = makeCtx();
    await run("to_flight_assistant", { request: "move my flight" }, ctx);
    await run("to_flight_assistant", { request: "actually a later one" }, ctx);
    expect(stateOf(ctx).dialogState).toEqual(["primary", "flight"]);
  });

  test("complete_or_escalate pops, and never past the concierge", async () => {
    const ctx = makeCtx();
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

// ─── 2. The confirmation gate ────────────────────────────────────────────────
//
// Their graph halts before a sensitive tool (`interrupt_before`) and resumes on
// approval. Here every sensitive tool stages and applies nothing, so the
// approval has somewhere to arrive. These are the tests that matter: a
// regression makes the agent able to rebook a flight BY MISTAKE.

describe("sensitive tools stage rather than act", () => {
  test.each([
    ["update_ticket", { flightId: "LX52" }],
    ["cancel_ticket", {}],
    ["book_hotel", { hotelId: "H1", nights: 2 }],
    ["book_car_rental", { carId: "C2", days: 3 }],
    ["book_excursion", { excursionId: "E2" }],
  ])("%s changes nothing on its own", async (name, args) => {
    const ctx = makeCtx();
    const before = structuredClone(stateOf(ctx));

    const staged = (await run(name, args, ctx)) as { awaitingConfirmation: boolean };
    expect(staged.awaitingConfirmation).toBe(true);

    const after = stateOf(ctx);
    expect(after.ticket).toEqual(before.ticket);
    expect(after.bookings).toEqual([]);
    expect(after.pending).not.toBeNull();
  });

  test("confirm_action applies the staged change, and only then", async () => {
    const ctx = makeCtx();
    await run("book_hotel", { hotelId: "H1", nights: 3 }, ctx);

    // Staging moved the gate, in the same window it wrote `pending`.
    expect(gateFlow.position(ctx).state).toBe("awaitingConfirmation");

    // A gated tool answers the flow's POSITION wrapped around the body's own
    // return value, so the applied sentence is under `result`. `okPosition`
    // keeps the position and THROWS on a refusal, quoting it — where the cast
    // it replaces read `undefined` off the failure and died three assertions
    // later on a property of undefined.
    const confirmed = okPosition<{ applied: string; reference: string }>(
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
    expect(await run("confirm_action", ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "browsing"'),
    });
  });

  test("cancel_action drops the staged change and leaves the booking alone", async () => {
    const ctx = makeCtx();
    await run("update_ticket", { flightId: "LX54" }, ctx);
    const dropped = okPosition<{ discarded: string }>(await run("cancel_action", ctx));
    expect(dropped.result.discarded).toContain("LX54");
    expect(dropped.state).toBe("browsing");

    const state = stateOf(ctx);
    expect(state.pending).toBeNull();
    expect(state.ticket?.flightId).toBe("LX40");
    expect(await run("cancel_action", ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "browsing"'),
    });
  });

  test("a staged action naming something that does not exist is refused at staging time", async () => {
    // Refused where the model can still recover — before the caller is asked to
    // confirm a flight the airline does not fly.
    const ctx = makeCtx();
    expect(await run("update_ticket", { flightId: "ZZ99" }, ctx)).toEqual({
      error: "No flight ZZ99 in the schedule.",
    });
    expect(stateOf(ctx).pending).toBeNull();
  });

  test("cancelling the ticket makes a later ticket change impossible", async () => {
    const ctx = makeCtx();
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
    // tools in one step is ordinary: the model hears "move my flight and book
    // the hotel" and emits both. Assigning `pending` unconditionally made the
    // second win — both answered `awaitingConfirmation`, the caller said yes
    // once, and one of the two changes was silently dropped forever.
    const ctx = makeCtx();
    const first = (await run("update_ticket", { flightId: "LX52" }, ctx)) as {
      awaitingConfirmation: boolean;
    };
    expect(first.awaitingConfirmation).toBe(true);

    const second = (await run("book_hotel", { hotelId: "H1", nights: 2 }, ctx)) as {
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
    // `ok` is `okPosition` with `.result` taken off: this assertion is about
    // what the apply DID, not about where the gate landed.
    const applied = ok<{ applied: string }>(await run("confirm_action", ctx));
    expect(applied.applied).toContain("LX52");
    expect(stateOf(ctx).bookings).toEqual([]);

    // Once the queue is clear, the hotel can be staged after all.
    const retried = (await run("book_hotel", { hotelId: "H1", nights: 2 }, ctx)) as {
      awaitingConfirmation: boolean;
    };
    expect(retried.awaitingConfirmation).toBe(true);
  });

  test("cancel_action clears the block, so a declined change does not wedge the desk", async () => {
    const ctx = makeCtx();
    await run("book_car_rental", { carId: "C2", days: 3 }, ctx);
    await run("cancel_action", ctx);
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
    const first = makeCtx();
    const second = makeCtx();

    await run("to_hotel_assistant", { request: "a room" }, first);
    await run("book_hotel", { hotelId: "H3", nights: 1 }, first);
    await run("confirm_action", first);

    expect(activeAssistant(stateOf(second))).toBe("primary");
    expect(stateOf(second).bookings).toEqual([]);
    // The GATE is per-session too, not just the trip.
    expect(gateFlow.position(second).state).toBe("browsing");
    expect(await run("confirm_action", second)).toMatchObject({
      error: expect.stringContaining('this conversation is at "browsing"'),
    });
    expect(stateOf(first).bookings).toHaveLength(1);
  });
});

// ─── 3. Search ───────────────────────────────────────────────────────────────

describe("search tools", () => {
  test("an unmatched route widens to the whole schedule rather than answering nothing", async () => {
    const ctx = makeCtx();
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

  test("hotels come back cheapest first, and a ceiling filters them", async () => {
    const ctx = makeCtx();
    const all = (await run("search_hotels", { city: "Boston" }, ctx)) as {
      hotels: { perNight: string }[];
    };
    expect(all.hotels.map((h) => h.perNight)).toEqual(["$180", "$265", "$340"]);

    const cheap = (await run("search_hotels", { city: "Boston", maxPerNight: 200 }, ctx)) as {
      hotels: { name: string }[];
    };
    expect(cheap.hotels).toHaveLength(1);
    expect(cheap.hotels[0]?.name).toBe("Cambridge Rooms");
  });

  test("an excursion keyword that matches nothing falls back to the city", async () => {
    const ctx = makeCtx();
    const result = (await run("search_excursions", { city: "Boston", keyword: "skiing" }, ctx)) as {
      widened: boolean;
      excursions: unknown[];
    };
    expect(result.widened).toBe(true);
    expect(result.excursions).toHaveLength(3);
  });

  test("lookup_booking reports the ticket the caller is actually holding", async () => {
    const ctx = makeCtx();
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
    const ctx = makeCtx();
    await run("to_car_rental_assistant", { request: "a car for the week" }, ctx);
    await run("book_car_rental", { carId: "C3", days: 4 }, ctx);

    const view = tripView(stateOf(ctx));
    expect(view.assistant).toBe("car_rental");
    expect(view.assistantTitle).toBe("car rental desk");
    // $95/day × 4 — the sidebar and the spoken read-back derive from one string.
    expect(view.pending).toContain("$380");
    expect(view.log.at(-1)).toContain("Awaiting confirmation");
  });

  test("totals every confirmed booking", async () => {
    const ctx = makeCtx();
    await run("book_hotel", { hotelId: "H3", nights: 2 }, ctx); // 2 × 180
    await run("confirm_action", ctx);
    await run("book_excursion", { excursionId: "E1" }, ctx); // 35
    await run("confirm_action", ctx);

    const view = tripView(stateOf(ctx));
    expect(view.total).toBe(395);
    expect(view.bookings.map((b) => b.kind)).toEqual(["hotel", "excursion"]);
    expect(view.pending).toBeNull();
  });
});
