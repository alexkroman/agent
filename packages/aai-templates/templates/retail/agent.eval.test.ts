/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares, plus
 * what `system-prompt.md` says.
 *
 * Driving the raw default export instead would measure a seventeen-tool desk
 * with no tools and the FRAMEWORK DEFAULT prompt — and for this template that
 * is the whole subject: the authenticate-first discipline, the three-step
 * readback and the one-customer-per-call rule all live in that file.
 */
import retailAgent from "virtual:aai/agent";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
// An EVAL: does this desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives each tool directly and asserts about its result;
// `registry.test.ts` asserts every tool's gate one at a time. Neither can say
// whether the AGENT — a model, reading this system prompt, holding these
// seventeen tools — puts them in the right ORDER. That is what this file is
// for, and the four things it asserts are the four this template's whole shape
// exists to guarantee:
//
//   1. nothing about an order is reachable before the caller is identified,
//   2. a change is STAGED and the store is untouched,
//   3. an explicit yes applies it, exactly once,
//   4. after a handoff the call is over and every tool refuses.
//
// Each one is a MECHANISM (a dialog gate, a plan/apply split, a terminal
// state), so each assertion reads the mechanism's own output — the SDK's
// refusal sentence, the tool result, and the projection the browser is sent —
// rather than judging the sentence the model chose to say.
//
// What no eval here can see: anything below the audio boundary. Whether a
// caller reading an order number in bursts lands as one turn is a property of
// endpointing, and these fake speech stages remove it.
import { describeTurn, lastStateIn, toolNames, turnCalling } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/** Harper Brown: exactly ONE pending order, which is what makes "cancel my
 *  pending order" unambiguous — `resolveOrder` refuses a reference that matches
 *  two, so a persona with two pending orders would put this eval's subject
 *  (the confirmation gate) behind a disambiguation turn. */
const CALLER_EMAIL = "harper.brown3965@example.com";
const PENDING_ORDER = "#W2273069";

/** The six tools that legitimately run before the caller is identified — the
 *  ones declaring `when: BEFORE_TRANSFER`. Anything else must refuse. */
const PUBLIC_TOOLS = new Set([
  "find_user_id_by_email",
  "find_user_id_by_name_zip",
  "get_product_details",
  "get_item_details",
  "list_all_product_types",
  "transfer_to_human_agents",
]);

/**
 * What the BROWSER is sent, as this eval reads it.
 *
 * Parsed rather than cast: `state.updated` carries `unknown`, and a schema that
 * stops matching is a loud failure naming the field, where a cast would hand
 * the assertions `undefined` and fail three lines later. It names only the
 * fields asserted below, so `storeView` may grow without touching this.
 */
const ProjectedStore = z.object({
  customer: z.object({ userId: z.string() }).nullable(),
  orders: z.array(z.object({ orderId: z.string(), status: z.string() })),
  pending: z.object({ kind: z.string(), readBack: z.string() }).nullable(),
});

/**
 * The latest projection the session pushed, or undefined if it pushed none.
 *
 * `lastStateIn` is the SDK's reader; the schema is what is worth passing to it,
 * for the reason above — a frame that stopped matching fails naming the field.
 */
const projection = (events: readonly SessionEvent[]) => lastStateIn(events, ProjectedStore);

/** The status the projection carries for `orderId` — the one fact "did anything
 *  change?" turns on. `undefined` covers both "no projection yet" and "not this
 *  customer's order", which are the same claim here: it was not touched. */
function statusOf(events: readonly SessionEvent[], orderId: string): string | undefined {
  return projection(events)?.orders.find((o) => o.orderId === orderId)?.status;
}

/**
 * The dialog gate's own refusal sentence, for the state it names.
 *
 * The character class absorbs the JSON escaping: a tool result reaches the
 * event stream as a serialized string, so the state name arrives inside
 * `\\"identifying\\"` rather than plain quotes.
 */
const refusalAt = (state: string) =>
  new RegExp(`Not available yet: this conversation is at [\\\\"]*${state}`);

/** One line the caller says to identify themselves, and the scripted tool call
 *  that answers it — the first turn of three of these four cases. */
const AUTH_TURN = [
  { tool: "find_user_id_by_email", args: { email: CALLER_EMAIL } },
  "Thanks — I have your account here. What can I do for you?",
] as const;

/** The staged cancellation, as a scripted turn. */
const STAGE_TURN = [
  {
    tool: "cancel_pending_order",
    args: { order_id: PENDING_ORDER, reason: "ordered by mistake" },
  },
  "So that would cancel your pending order and refund one thousand two hundred dollars " +
    "and fifty-seven cents to your Visa. Is that right?",
] as const;

describeEval(retailAgent, (test) => {
  test(
    "will not touch an order before the caller is identified",
    async ({ session }) => {
      const turn = await session.say(
        "Hi — cancel my pending order please, number W two two seven three zero six nine. " +
          "I don't need it any more.",
      );

      // The claim is about the GATE, so it is made of every gated call the
      // model chose to make: each one has to have been refused, and the
      // refusal has to say where the call actually is. A model that asks for
      // the email instead makes no gated call at all, which satisfies this
      // vacuously and is the same right answer — the two remaining assertions
      // are what stop the case being vacuous overall.
      for (const call of turn.toolCalls) {
        if (PUBLIC_TOOLS.has(call.name)) continue;
        expect(call.result).toMatch(refusalAt("identifying"));
      }
      // Nothing was authenticated, so the browser has been sent no customer —
      // which is also the projection's security claim.
      expect(projection(session.events())?.customer ?? null).toBeNull();
      // And it asked for the one thing it needs.
      expect(turn.text).toMatch(/email|account|name|zip/i);
    },
    {
      stubReply: [
        {
          tool: "cancel_pending_order",
          args: { order_id: PENDING_ORDER, reason: "no longer needed" },
        },
        "Before I can look anything up I'll need to find your account — what's the email on it?",
      ],
    },
  );

  test(
    "stages a cancellation and changes nothing until the caller says yes",
    async ({ session }) => {
      // FIVE lines, because how many turns this desk takes to STAGE is its own
      // business and measured live it varies by two: reading the order back out
      // of `get_order_details` and asking "does that sound right?" is a whole
      // turn, and whether it spends one is not something an eval should pin.
      // Every assertion below is about the turn the staging landed in, so a
      // later apply cannot affect any of them.
      const turns = await session.sayAll([
        `My email is ${CALLER_EMAIL}.`,
        "I'd like to cancel my pending order — I ordered it by mistake.",
        "Yes, please go ahead and cancel it.",
        "Yes — I'm sure. Cancel it.",
        "Yes. Cancel it, please.",
      ]);

      // The turn the staging landed in, whichever it was — measured live it has
      // been turn two, three and four. `turnCalling` throws when no turn staged
      // at all, naming every turn's tool list: a desk that talked through all
      // five without staging is the finding, and "expected undefined to be
      // defined" is not a report of it.
      const staging = turnCalling(turns, "cancel_pending_order");
      const staged = staging.toolCalls.find((c) => c.name === "cancel_pending_order");
      expect(staged?.result).toMatch(/NOTHING HAS CHANGED YET/);
      // The gate is a POSITION, and this is it moving: the tool reported the
      // state it landed in, which is the only state `confirm_change` is legal
      // in and is reachable only by staging.
      expect(staged?.result).toMatch(/serving\.awaitingConfirmation/);
      // A change cannot be described and applied in the same turn. This is the
      // property the prose in the system prompt could never have.
      expect(toolNames(staging.toolCalls)).not.toContain("confirm_change");
      // And after the turn that staged it, the store really is untouched — read
      // off the projection the BROWSER was sent in that same turn.
      expect(statusOf(staging.events, PENDING_ORDER)).toBe("pending");
      expect(projection(staging.events)?.pending?.kind).toBe("cancel_pending_order");
      // Step 2 of the policy: read it back and ask.
      expect(staging.text).toMatch(/\?/);
    },
    { stubReply: [...AUTH_TURN, ...STAGE_TURN, "Cancelling it now — one moment."] },
  );

  test(
    "applies the staged change on an explicit yes, exactly once",
    async ({ session }) => {
      // Five lines, three of them a yes: which turn the desk applies the change
      // in is its own business, and saying yes repeatedly is what makes
      // "exactly once" below a claim about the MECHANISM rather than about the
      // model's pacing.
      await session.sayAll([
        `My email is ${CALLER_EMAIL}.`,
        "Please cancel my pending order — I ordered it by mistake.",
        "Yes, that's right, go ahead.",
        "Yes — confirm it now, please.",
        "Yes. Confirm it.",
      ]);

      const confirms = session.toolCalls().filter((c) => c.name === "confirm_change");
      const applied = confirms.filter((c) => c.result?.includes('"status":"cancelled"'));
      // ONE apply for the whole call, however many times the caller said yes.
      // Measured live, a second yes really does produce a second
      // `confirm_change` — and it is REFUSED, because applying cleared
      // `pending` and sent `SETTLED`, and `awaitingConfirmation` is reachable
      // only by staging something new. That is the gate doing the one job a
      // prompt could not: a repeated yes cannot cancel an order twice.
      expect(applied).toHaveLength(1);
      for (const extra of confirms.filter((c) => c !== applied[0])) {
        expect(extra.result).toMatch(/Not available yet/);
      }
      // And it came after the stage, never instead of it.
      const names = toolNames(session.toolCalls());
      expect(names.indexOf("cancel_pending_order")).toBeGreaterThanOrEqual(0);
      expect(names.indexOf("confirm_change")).toBeGreaterThan(
        names.indexOf("cancel_pending_order"),
      );
      // The store moved, and the staged change is gone with it.
      expect(statusOf(session.events(), PENDING_ORDER)).toBe("cancelled");
      expect(projection(session.events())?.pending).toBeNull();
    },
    {
      stubReply: [
        ...AUTH_TURN,
        ...STAGE_TURN,
        { tool: "confirm_change", args: {} },
        "That's cancelled, and the refund is on its way to your Visa.",
      ],
    },
  );

  test(
    "hands the call to a human and then refuses everything, including the order",
    async ({ session }) => {
      await session.say(`My email is ${CALLER_EMAIL}.`);
      const handoff = await session.say(
        "This isn't working for me — I want to speak to a real person.",
      );

      const transfer = handoff.toolCalls.find((c) => c.name === "transfer_to_human_agents");
      // Named first, and with a message: a live model that answers the request
      // with a question instead of the tool leaves `transfer` undefined, and
      // `.toMatch()` on it reports only "expected a string, got undefined" —
      // which says nothing about what the desk actually did. `describeTurn` is
      // that sentence, done by the harness: the tools it called and what it
      // said, plus whether the reply was cancelled.
      expect(transfer, describeTurn(handoff)).toBeDefined();
      // The terminal state is what makes "say nothing else after this" a
      // property of the agent rather than a line in its prompt: `done` is the
      // flow saying there is nowhere left to go.
      expect(transfer?.result).toMatch(/"state":"transferred"/);
      expect(transfer?.result).toMatch(/"done":true/);

      const after = await session.say("Actually, before you go — just cancel my pending order.");
      for (const call of after.toolCalls) {
        expect(call.result).toMatch(refusalAt("transferred"));
      }
      // Which is the point: the order the caller asked about is untouched.
      expect(statusOf(session.events(), PENDING_ORDER)).toBe("pending");
    },
    {
      stubReply: [
        ...AUTH_TURN,
        {
          tool: "transfer_to_human_agents",
          args: { summary: "Caller asked for a human agent." },
        },
        "You are being transferred to a human agent. Please hold on.",
        {
          tool: "cancel_pending_order",
          args: { order_id: PENDING_ORDER, reason: "no longer needed" },
        },
        "You are being transferred to a human agent. Please hold on.",
      ],
    },
  );
});
