import agentDef from "virtual:aai/agent";
import { isToolFailure } from "@alexkroman1/aai/utils";
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
import {
  describeEval,
  evalSimulation,
  lastStateIn,
  lastToolResultIn,
  statesIn,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { MENU, orderSlot } from "./shared.ts";
import addPizza from "./tools/add_pizza.ts";
import placeOrder from "./tools/place_order.ts";

describeEval(agentDef, (test) => {
  test(
    "adds the pizza the caller described, at the price the menu quotes",
    async ({ session }) => {
      const turn = await session.say(
        "Hi, I'd like a large pepperoni pizza with extra cheese please.",
      );

      // One tool, and the right one: quoting a price without adding the pizza,
      // or adding it twice, are both real findings.
      expect(toolNames(turn.toolCalls)).toEqual(["add_pizza"]);
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
      expect(toolResultIn(turn.toolCalls, addPizza).orderTotal).toBe(`$${expected.toFixed(2)}`);
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

      expect(toolNames(turn.toolCalls)).toEqual(["update_pizza"]);
      const call = turn.toolCalls[0]!;
      expect(call.args).toMatchObject({ pizza_id: 1, size: "large" });

      // And the cart the page renders is the same one: still one pizza, resized
      // rather than replaced, with the mushrooms from the first turn intact.
      // `lastStateIn` over the slot's own projection is the frame
      // `useAgentState(orderSlot.projected)` renders in `client.tsx`.
      const view = lastStateIn(turn.events, orderSlot.projected);
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
        const placed = toolResultIn([call], placeOrder);
        if (!isToolFailure(placed)) throw new Error(`placed order #${placed.orderNumber}`);
        expect(placed.error).toContain("Cannot place an empty order");
      }
      expect(turn.completed).toBe(true);
      // Nothing the session pushed to the page may claim an order was placed —
      // the SEQUENCE, not only the last frame.
      const views = statesIn(session.events(), orderSlot.projected);
      expect(views.filter((view) => view.orderPlaced)).toEqual([]);
    },
    { stubReply: [{ tool: "place_order" }, "There's nothing in your order yet."] },
  );

  test(
    "a simulated caller orders a pizza and gets it placed",
    async ({ session, mode }) => {
      // Every case above is one line the test author wrote. A real order is a
      // few turns the CALLER steers: they name the pizza, maybe forget the
      // crust, and say when they are done. A second model plays that caller,
      // so what is under test is whether the order survives a conversation
      // nobody scripted — the cart in the slot, across however many turns it
      // took. Keyless, the caller and the judge are scripted too, and the case
      // proves the loop is wired and nothing else.
      const { simulate, judge } = evalSimulation({
        agent: agentDef,
        mode,
        target: session,
        stubCaller: [
          "Hi, can I get a large pepperoni pizza, regular crust?",
          "That's everything, please place the order.",
          { tool: "end_call", args: { reason: "order placed" } },
        ],
      });
      const call = await simulate({
        persona: "a hungry customer calling a pizza shop, who answers in short sentences",
        goal:
          "order exactly one large pepperoni pizza on regular crust, then have the order " +
          "placed and hear the order number",
      });

      expect(call.endedBy, call.transcript()).toBe("caller");
      // Deterministic first: the pizza the caller wanted went into the cart,
      // and the order that was placed had it in it. `place_order` resets the
      // cart it read, so its RESULT is where the placed order is on record.
      const calls = call.metrics.toolCalls;
      const added = calls.filter((c) => c.name === "add_pizza");
      expect(added.length, call.transcript()).toBeGreaterThan(0);
      expect(added.at(-1)?.args).toMatchObject({ size: "large" });
      const placed = lastToolResultIn(calls, placeOrder);
      if (isToolFailure(placed)) throw new Error(placed.error);
      expect(placed.pizzas).toBe(1);

      // What the tool results cannot show is what the caller HEARD. The prompt
      // says every price comes from a tool and every change is confirmed.
      const verdict = await judge(call, [
        "The agent confirmed the pizza it added (size and toppings) back to the caller.",
        "After placing the order, the agent told the caller an order number.",
      ]);
      expect(verdict.pass, verdict.explain()).toBe(true);
    },
    {
      stubReply: [
        {
          tool: "add_pizza",
          args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 },
        },
        "Added a large pepperoni on regular crust. Anything else?",
        { tool: "place_order" },
        "Your order is placed. It should be ready in about twenty minutes.",
      ],
    },
  );
});
