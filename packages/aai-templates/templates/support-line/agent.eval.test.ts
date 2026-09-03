// An EVAL: does the line really refuse to say what it cannot ground? Run it
// with `aai eval`.
//
// `agent.test.ts` drives the retriever and each CRAG node directly. What it
// cannot see is the claim this template exists to make — that a MODEL holding
// this tool list cannot state a fee it did not just retrieve. So these cases
// drive a real session and read the verdicts off the tool results: which
// documents the grader passed, whether the answer was grounded, and whether an
// answer it could not ground was WITHHELD.
//
// **One thing a SCRIPTED run cannot reach: `ctx.generate` with a SCHEMA.** The
// stub model registers as an LLM provider, so `ctx.generate` resolves it, and it
// answers a plain text generation from the script. Every node in this template's
// loop passes a `schema` though (`binaryScore`), and that overload comes back
// `{"error":"The knowledge base lookup failed: No output generated."}` — so the
// whole corrective loop is unreachable scripted. That is the template's central
// tool, so the two cases that run without a key are written as invariants both
// modes satisfy (a failed lookup is REPORTED, never answered around), and the
// two that read a real verdict are `{ live: true }`.
//
// **`system-prompt.md` is applied HERE, not by `agent.ts`.** The build discovers
// the file, so an eval driving the raw default export would run this agent with
// the FRAMEWORK DEFAULT prompt — and the discipline that prompt imposes is the
// entire subject of this file. Measured against the default: the model answers
// product questions from its own knowledge and skips the tools the prompt exists
// to route it through, so a case run that way measures nothing it claims to.

/** The def a DEPLOYED agent runs — see `agent.test.ts` on why the glob is here. */
import agentDef from "virtual:aai/agent";
import { type EvalSession, statesIn, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/**
 * What the BROWSER is sent, as this eval reads it.
 *
 * Parsed rather than cast: `state.updated` carries `unknown`, so a projection
 * that stopped matching FAILS naming the field, where the cast this replaced
 * handed the assertions `undefined` and failed a line later on something else.
 * It names only the fields asserted below, so `supportView` may grow without
 * touching this.
 */
const ProjectedSupport = z.object({
  ticket: z.string().nullable(),
  trace: z
    .object({
      exhausted: z.boolean(),
      docs: z.array(z.object({ relevant: z.boolean() })),
      steps: z.array(z.object({ node: z.string() })),
    })
    .nullable(),
});

/**
 * What `answer_question` answered, validated.
 *
 * All-optional, and that is the shape of the CONTRACT rather than laxness: the
 * tool has three legal outcomes — a graded answer, a withheld one carrying
 * guidance, and a reported failure — so a required field would fail two of the
 * three. What the schema still buys is that a field the case reads is the type
 * the case thinks it is.
 */
const Lookup = z.object({
  answer: z.string().nullable().optional(),
  sources: z.array(z.string()).optional(),
  grounded: z.boolean().optional(),
  answersTheQuestion: z.boolean().optional(),
  rewrites: z.number().optional(),
  guidance: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Every `syncState` frame, in stream order.
 *
 * `statesIn` reads an EVENT LIST rather than a session, which is what lets a
 * case slice the stream first; the schema above is what it takes one for.
 */
function frames(session: EvalSession) {
  return statesIn(session.events(), ProjectedSupport);
}

/**
 * What `answer_question` answered, in call order.
 *
 * `toolResultIn` over a ONE-CALL list per call: the name is that call's own, so
 * the reader's "no such call" and "two calls" throws are unreachable and what is
 * left is the parse, the schema, and its "never completed" failure — which is
 * the half the hand-rolled `JSON.parse(call.result ?? "null")` this replaced got
 * wrong, reading `null` for a tool that never came back.
 */
function lookups(session: EvalSession) {
  return session
    .toolCalls()
    .filter((call) => call.name === "answer_question")
    .map((call) => toolResultIn([call], call.name, Lookup));
}

describeEval(agentDef, (test) => {
  test(
    "nothing about the product is said without going through the knowledge base",
    async ({ session }) => {
      const turn = await session.say("How much notice do I have to give if I want to cancel?");

      // The prompt's one rule: `answer_question` is the only route to anything
      // about Meridian Fibre. A model that answered a notice period from its own
      // knowledge would sound identical down a phone.
      const asked = turn.toolCalls.filter((call) => call.name === "answer_question");
      // The reply rides in the message, because the failure that matters here is
      // a turn that SPOKE without looking anything up — "let me check that for
      // you" and then nothing, or worse, a notice period from memory.
      expect(
        asked.length,
        `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}`,
      ).toBe(1);

      for (const payload of lookups(session)) {
        // Three legal outcomes, and the invariant that spans them: an answer the
        // caller is given is an answer the hallucination grader passed. `grounded:
        // false` reaching the model is the one thing the whole apparatus exists
        // to prevent — and a broken lookup is REPORTED rather than worked around.
        if (payload.error !== undefined) continue;
        if (payload.answer === null) continue;
        expect(payload.grounded, `ungrounded answer handed to the model: ${payload.answer}`).toBe(
          true,
        );
      }
    },
    {
      stubReply: [{ tool: "answer_question", args: { question: "notice to cancel" } }, "One sec."],
    },
  );

  test(
    "a logged ticket's callback number never leaves the server",
    async ({ session }) => {
      // Two turns, because that is the shape the prompt asks for: the lookup comes
      // back empty, the line offers a ticket, and only then is there a number to
      // take. Asked for in one breath, a live model reasonably answers the offer
      // instead of acting on it.
      await session.say("Can I add a pay-monthly mobile SIM to my broadband account?");
      await session.say("Yes please, log that one — my callback number is 07700 900123.");

      const logged = session.toolCalls().find((call) => call.name === "log_ticket");
      expect(
        logged,
        `tools called: ${session
          .toolCalls()
          .map((c) => c.name)
          .join(", ")}`,
      ).toBeDefined();
      expect(logged?.result).toMatch(/TCK\d{4}/);

      const latest = frames(session).at(-1);
      // The projection carries the REFERENCE and nothing else — that is why
      // `supportView` exists rather than `syncState` taking the state itself.
      expect(latest?.ticket).toMatch(/^TCK\d{4}$/);
      for (const frame of frames(session)) {
        expect(JSON.stringify(frame)).not.toMatch(/900123/);
      }
    },
    {
      stubReply: [
        { tool: "answer_question", args: { question: "add a mobile SIM to my account" } },
        "I don't have that documented. Shall I log a ticket for a callback?",
        {
          tool: "log_ticket",
          args: { question: "add a mobile SIM to my account", callback: "07700 900123" },
        },
        "That's logged — the reference is T C K four thousand and one.",
      ],
    },
  );

  test(
    "the answer comes from the document the caller asked about, not the one next to it",
    async ({ session }) => {
      // Short and single, deliberately: the claim here is which document the
      // grader passed, so the question is phrased to measure that and not the
      // loop's pacing.
      //
      // It used to say the corrective path could not fit the runtime's 30s
      // per-tool deadline. Re-measured against the live gateway, that is no
      // longer true by an order of magnitude — the two-attempt path runs in
      // 2.8s of nine model calls — so the phrasing above is a choice about what
      // this case measures rather than a way around a clock. The numbers and
      // what they do and do not license are on `LOOKUP_BUDGET_MS` in
      // `tools/answer_question.ts`.
      const turn = await session.say("How much notice do I have to give to cancel my contract?");

      const [payload] = lookups(session);
      expect(
        payload,
        `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}`,
      ).toBeDefined();
      // The whole verdict in the message: `grounded: undefined` on its own does
      // not say whether the lookup failed, or ran and refused.
      const verdict = JSON.stringify(payload);
      expect(payload?.grounded, verdict).toBe(true);
      expect(payload?.answersTheQuestion, verdict).toBe(true);

      const sources = payload?.sources ?? [];
      expect(sources).toContain("Cancelling your contract");
      // THE claim, and the reason the knowledge base is built the way it is:
      // "cancelling your contract" and "cancelling an engineer visit" are two
      // documents, two fees and one word apart. A retriever with no grader hands
      // back both, and sixty pounds gets read down the phone as the answer to a
      // contract question.
      expect(sources).not.toContain("Cancelling or rebooking an engineer visit");
      // Either spelling: the claim is that the notice period came out of D5, not
      // how the answer prompt chose to write a numeral.
      expect(String(payload?.answer)).toMatch(/thirty days|30 days/i);
      expect(String(payload?.answer)).not.toMatch(/sixty pound|abortive/i);
      expect(turn.text).not.toMatch(/sixty|abortive/i);
    },
    // Live only: the grader's verdict IS the measurement.
    //
    // THE CLOCK, and it is no longer the limit it was recorded as here.
    // `answer_question` is up to eleven sequential model calls and the tool
    // executor abandons any tool at `TOOL_EXECUTION_TIMEOUT_MS` (30s) — a
    // deadline neither an agent author nor an eval can raise — so this comment
    // used to say the two-attempt corrective path did not fit, which made this
    // case a coin toss on the gateway rather than a reading of the grader.
    // Re-measured: the whole loop is 2.0-3.1s, the corrective path 2.8s of nine
    // calls, and eight consecutive live runs of this suite were green. The
    // margin belongs to the service, not to us, so the tool keeps its own
    // budget and this case keeps a question that settles on one attempt; if the
    // gateway slows down again the failure says which, because a spent budget
    // comes back as the graph's own exit sentence rather than as a timeout.
    { live: true },
  );

  test(
    "a question nothing covers is refused, after the corrective edge has tried",
    async ({ session }) => {
      const turn = await session.say(
        "Can I add a pay-monthly mobile SIM with unlimited data to my broadband account?",
      );

      const [payload] = lookups(session);
      expect(
        payload,
        `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}`,
      ).toBeDefined();
      // Withheld, not softened: `answer: null` is the tool refusing to hand the
      // model something to read out, and the guidance is the exit the grading
      // apparatus needs — a support line that can only answer will answer wrong.
      // A lookup that BROKE and one that ran and found nothing are different
      // findings, and neither is readable from "answer is not null".
      expect(payload?.answer, JSON.stringify(payload)).toBeNull();
      expect(String(payload?.guidance)).toMatch(/log_ticket/);
      // The corrective edge really ran: nothing relevant means the RETRIEVAL was
      // wrong, so the query is rewritten and retried before the loop gives up.
      expect(payload?.rewrites).toBeGreaterThanOrEqual(1);

      const trace = frames(session).at(-1)?.trace;
      expect(trace?.exhausted).toBe(true);
      expect(trace?.docs.every((doc) => !doc.relevant)).toBe(true);
      expect(trace?.steps.map((step) => step.node)).toContain("transform_query");
    },
    { live: true },
  );
});
