/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
// An EVAL: does the order-taker actually take the order?
//
// `agent.test.ts` drives the six tools directly, which settles what each one
// does with the arguments it is given. What no test in it can settle is whether
// the MODEL reaches for the right one, with the arguments the caller actually
// said — and for a cart that lives in a `sessionSlot`, whether what turn 1
// wrote is still there on turn 2. That is what this file is for.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent, still
// resolves `tools/`, and still executes the tool a script names — so a stub run
// proves the wiring and proves nothing about what the agent chose.
import { lastStateIn, statesIn, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { MENU } from "./shared.ts";

/**
 * What the BROWSER is sent, as this eval reads it.
 *
 * Parsed rather than cast: `state.updated` carries `unknown`, so a projection
 * that stopped matching FAILS naming the field, where the cast this replaced
 * handed the assertions `undefined` and failed a line later on something else.
 * It names only the fields asserted below, so `orderView` may grow without
 * touching this.
 */
const ProjectedOrder = z.object({
  pizzas: z.array(z.object({ id: z.number(), size: z.string(), toppings: z.array(z.string()) })),
  orderPlaced: z.boolean(),
});

/**
 * The last cart `syncState` pushed to the browser, i.e. what the page shows.
 *
 * This agent declares ONE projection, so the frame IS `orderView`'s result —
 * not a record keyed by the slot. That is the same value `useAgentState(
 * orderProjection)` reads in `client.tsx`, which is why an eval can assert on
 * it: it is the cart the customer is looking at. `lastStateIn` is the SDK's
 * reader for exactly this.
 */
const lastPushedView = (events: readonly SessionEvent[]) => lastStateIn(events, ProjectedOrder);

/**
 * Every cart the session pushed, in stream order — `statesIn` is `lastStateIn`'s
 * plural half, and takes the schema for the same reason.
 *
 * The SEQUENCE is the stronger claim: not "the cart is not placed now" but "no
 * frame the customer ever saw showed it placed".
 */
const pushedViews = (events: readonly SessionEvent[]) => statesIn(events, ProjectedOrder);

describeEval(agentDef, (test) => {
  test(
    "adds the pizza the caller described, at the price the menu quotes",
    async ({ session }) => {
      const turn = await session.say(
        "Hi, I'd like a large pepperoni pizza with extra cheese please.",
      );

      // One tool, and the right one: quoting a price without adding the pizza,
      // or adding it twice, are both real findings.
      expect(turn.toolCalls.map((c) => c.name)).toEqual(["add_pizza"]);
      const call = turn.toolCalls[0]!;
      const args = call.args as { size: string; crust: string; toppings: string[] };
      expect(args.size).toBe("large");
      // The two toppings the caller named, however the model spelled them.
      const toppings = args.toppings.map((t) => t.toLowerCase().replaceAll(" ", "_"));
      expect(toppings).toContain("pepperoni");
      expect(toppings).toContain("extra_cheese");

      // The claim the template's own comment makes: the menu is generated from
      // MENU, so the agent can never quote a price the ordering code doesn't
      // charge. Computed from the menu here rather than from the tool's own
      // output, which is what gives it teeth — a topping name the pricing table
      // doesn't recognise silently falls back to $1.00.
      const expected =
        MENU.sizes[args.size as keyof typeof MENU.sizes] +
        MENU.crusts[args.crust as keyof typeof MENU.crusts] +
        MENU.toppings.pepperoni +
        MENU.toppings.extra_cheese;
      expect(
        toolResultIn(turn.toolCalls, "add_pizza", z.object({ orderTotal: z.string() })).orderTotal,
      ).toBe(`$${expected.toFixed(2)}`);
    },
    {
      stubReply: [
        {
          tool: "add_pizza",
          args: {
            size: "large",
            crust: "regular",
            toppings: ["pepperoni", "extra cheese"],
            quantity: 1,
          },
        },
        "Added a large pepperoni with extra cheese.",
      ],
    },
  );

  test(
    "changes the pizza it added a turn ago, by the id that turn returned",
    async ({ session }) => {
      await session.say("Can I get a medium thin crust pizza with mushrooms?");
      // The id only exists because turn 1 wrote it into the session's cart.
      // Nothing in this utterance names it, so a slot that did not survive the
      // turn leaves the model with nothing to address.
      const turn = await session.say("Actually, make that a large.");

      expect(turn.toolCalls.map((c) => c.name)).toEqual(["update_pizza"]);
      const call = turn.toolCalls[0]!;
      expect(call.args).toMatchObject({ pizza_id: 1, size: "large" });

      // And the cart the page renders is the same one: still one pizza, resized
      // rather than replaced, with the mushrooms from the first turn intact.
      const view = lastPushedView(turn.events);
      expect(view?.pizzas).toHaveLength(1);
      expect(view?.pizzas[0]).toMatchObject({ id: 1, size: "large", toppings: ["mushrooms"] });
    },
    {
      stubReply: [
        {
          tool: "add_pizza",
          args: { size: "medium", crust: "thin", toppings: ["mushrooms"], quantity: 1 },
        },
        "A medium thin crust with mushrooms, coming up.",
        { tool: "update_pizza", args: { pizza_id: 1, size: "large" } },
        "Made it a large.",
      ],
    },
  );

  test(
    "never places an empty order",
    async ({ session }) => {
      const turn = await session.say("That's everything, go ahead and place my order.");

      // The model may check the cart first, or answer from the fact that
      // nothing was ordered. What it may NOT do is get an order number: every
      // place_order call on an empty cart has to come back refused, which is
      // what stops the agent reading out a confirmation for nothing.
      for (const call of turn.toolCalls.filter((c) => c.name === "place_order")) {
        // `toolResultIn` over a ONE-CALL list: the name is this call's own, so
        // the reader's "no such call" and "two calls" throws are unreachable and
        // what is left is the parse plus the schema. The schema requires
        // `error`, which is the claim — a call that SUCCEEDED fails here.
        expect(toolResultIn([call], call.name, z.object({ error: z.string() })).error).toContain(
          "Cannot place an empty order",
        );
      }
      expect(turn.completed).toBe(true);
      // Nothing the session pushed to the page may claim an order was placed.
      expect(pushedViews(session.events()).filter((view) => view.orderPlaced)).toEqual([]);
    },
    { stubReply: [{ tool: "place_order" }, "There's nothing in your order yet."] },
  );
});
