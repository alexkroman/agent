/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
// An EVAL: does the front desk actually hand the caller to the right desk, and
// does the desk it lands on act as itself?
//
// `agent.test.ts` drives the tools directly, which settles what each one does.
// What no test in it can settle is whether the MODEL verifies before it looks
// up an invoice, hands a "my line is down" caller to support without a script,
// and — the claim personas exist for — whether the desk the caller lands on is
// still speaking on the NEXT turn, over the slot the first desk wrote.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent, still gates
// every tool on the active persona, and still executes the tool a script names
// — so a stub run proves the wiring and proves nothing about what the agent chose.
import { HANDOFF_TOOL_NAME } from "@alexkroman1/aai";
import { toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { evalSimulation } from "@alexkroman1/aai-runtime/eval/simulate";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

const Handoff = z.object({ handoff: z.literal(true), from: z.string(), to: z.string() });
const Refusal = z.object({ error: z.string() });
const Invoices = z.object({
  invoices: z.array(z.object({ id: z.string(), amount: z.number(), status: z.string() })),
});

describeEval(agentDef, (test) => {
  test(
    "verifies the caller and hands them to billing in one call",
    async ({ session }) => {
      const turn = await session.say(
        "Hi, my account number is 1001 and my zip is 94107. I have a question about my last bill.",
      );
      expect(toolNames(turn.toolCalls)).toEqual(["verify_account"]);
      const handed = toolResultIn(turn.toolCalls, "verify_account", Handoff);
      expect(handed).toMatchObject({ from: "triage", to: "billing" });
      expect(turn.completed).toBe(true);
    },
    {
      stubReply: [
        { tool: "verify_account", args: { accountNumber: "1001", zip: "94107", needs: "billing" } },
        "Thanks Dana, you're verified — this is billing. Which invoice is it about?",
      ],
    },
  );

  test(
    "does not open an invoice for an unverified caller — the desk's own tool refuses",
    async ({ session }) => {
      const turn = await session.say("Can you look up my latest invoice?");
      // Whatever the model chose, no invoice may have been READ: an invoice
      // lookup before verification is exactly what the gate exists to stop, and
      // a lookup attempted here is refused because billing is not speaking.
      for (const call of turn.toolCalls.filter((c) => c.name === "lookup_invoice")) {
        expect(toolResultIn([call], call.name, Refusal).error).toContain("billing persona");
      }
      expect(turn.completed).toBe(true);
    },
    {
      stubReply: [
        { tool: "lookup_invoice", args: {} },
        "Before I can do that I'll need your account number and zip code.",
      ],
    },
  );

  test(
    "routes a service problem to support on the caller's words alone",
    async ({ session }) => {
      const turn = await session.say(
        "I don't have a billing question, my internet has been down since this morning.",
      );
      expect(toolNames(turn.toolCalls)).toContain(HANDOFF_TOOL_NAME);
      expect(toolResultIn(turn.toolCalls, HANDOFF_TOOL_NAME, Handoff)).toMatchObject({
        from: "triage",
        to: "support",
      });
    },
    {
      stubReply: [
        {
          tool: HANDOFF_TOOL_NAME,
          args: { persona: "support", note: "Internet down since morning." },
        },
        "I'm sorry to hear that — this is support. Let me check your line.",
      ],
    },
  );

  test(
    "the desk the caller landed on is still speaking on the next turn",
    async ({ session }) => {
      await session.say("Account 1001, zip 94107, it's about a bill.");
      // Turn 2 names no desk and re-verifies nothing: billing's tool runs only
      // because the handoff turn 1 made is the session's, not the turn's.
      const turn = await session.say("What's on invoice INV-1001-2?");
      expect(toolNames(turn.toolCalls)).toEqual(["lookup_invoice"]);
      expect(toolResultIn(turn.toolCalls, "lookup_invoice", Invoices).invoices).toEqual([
        { id: "INV-1001-2", amount: 79.5, status: "open" },
      ]);
    },
    {
      stubReply: [
        { tool: "verify_account", args: { accountNumber: "1001", zip: "94107", needs: "billing" } },
        "You're verified, Dana. Which invoice?",
        { tool: "lookup_invoice", args: { invoiceId: "INV-1001-2" } },
        "Invoice one-oh-oh-one dash two is seventy-nine fifty, and it's still open.",
      ],
    },
  );

  test(
    "a simulated caller who volunteers nothing still gets verified and hears their bill",
    async ({ session, mode }) => {
      // The cases above hand the desk the account number and zip in the
      // caller's first breath, because a scripted line has to. A real caller
      // opens with the question and gives the numbers only when asked, which is
      // the order that tests whether the desk ASKS rather than whether it can
      // parse. A second model plays that caller. Keyless, it and the judge are
      // scripted, and the case proves the loop is wired and nothing else.
      const { simulate, judge } = evalSimulation({
        agent: agentDef,
        mode,
        target: session,
        stubCaller: [
          "Hi, I have a question about the invoice that's still open on my bill.",
          "Sure, account number 1001, zip code 94107.",
          "How much is the open one?",
          { tool: "end_call", args: { reason: "heard the amount" } },
        ],
      });
      const call = await simulate({
        persona:
          "Dana, a Northwind customer on the phone, who gives the account number 1001 and the " +
          "zip code 94107 only when the agent asks for them",
        goal: "find out how much the invoice that is still open on the account is for",
      });

      expect(call.endedBy, call.transcript()).toBe("caller");
      // Deterministic first: an invoice was really READ. `lookup_invoice` is
      // billing's tool and refuses anyone unverified, so a successful read is
      // proof the verification happened, whatever order the model tried things
      // in — and a refused attempt along the way is the gate working.
      const reads = call.metrics.toolCalls
        .filter((c) => c.name === "lookup_invoice")
        .map((c) => toolResultIn([c], c.name, Invoices.or(Refusal)))
        .flatMap((result) => ("invoices" in result ? result.invoices : []));
      expect(reads, call.transcript()).toContainEqual({
        id: "INV-1001-2",
        amount: 79.5,
        status: "open",
      });

      // What the tool results cannot show is the order the caller HEARD things
      // in, and whether the figure reached them in words.
      const verdict = await judge(call, [
        "The agent asked for the account number and zip code before giving any invoice details.",
        "The agent told the caller the open invoice is for $79.50.",
      ]);
      expect(verdict.pass, verdict.explain()).toBe(true);
    },
    {
      stubReply: [
        "I can help with that. What's your account number and zip code?",
        { tool: "verify_account", args: { accountNumber: "1001", zip: "94107", needs: "billing" } },
        "Thanks Dana, you're verified — this is billing. What would you like to know?",
        { tool: "lookup_invoice", args: {} },
        "Your open invoice, INV-1001-2, is for seventy-nine fifty.",
      ],
    },
  );
});
