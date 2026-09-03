// An EVAL: does the FAQ bot actually look things up?
//
// `agent.test.ts` scores the search index directly, which settles what
// `search_knowledge` returns for a query it is handed. What it cannot settle is
// the discipline this agent's whole prompt is about: that an answer comes from
// `knowledge.json` and not from what a model happens to know about the
// framework it is describing.
//
// Run it with `aai eval`. Without a provider key each case runs against a
// SCRIPTED model (its `stubReply`) — the real session and the real tools, a
// fake reply — which proves the wiring and says nothing about the discipline.

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS — a scaffolded project has no repo helper to import. Without
 * it this agent would have no tools and would answer every question from the
 * model's own memory, which is exactly what the cases below forbid.
 *
 * And plus its PROMPT. `agent.ts` does not declare one, because
 * `system-prompt.md` is resolved by the BUILD (`aai build`/`aai deploy`) — so
 * the raw default export carries the FRAMEWORK DEFAULT prompt. An eval that
 * drives it measures a different agent than the one that deploys, and every
 * tool-choice claim below then passes or fails for the wrong reason.
 */
import agentDef from "virtual:aai/agent";
import { toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { faqs } from "./shared.ts";

/**
 * A knowledge-base HIT, as the model saw it — `tool.completed` carries it
 * serialized, and `toolResultIn` parses and validates it.
 *
 * A schema rather than a cast, which is the whole reason to pass one: an index
 * that started answering with a different shape FAILS here naming the field,
 * where the cast this replaced would have read `undefined` off it and failed a
 * line later on something unrelated. `search_knowledge` also answers
 * `{ result: "No matching FAQ found." }` for a miss, so a miss fails HERE — and
 * a miss on this question is the finding.
 */
const FaqEntrySchema = z.object({ question: z.string(), answer: z.string() });

/** The knowledge-base entry this template's own answer about the web is in. */
const INTERNET = faqs.find((f) => f.question.includes("internet"))!;

describeEval(agentDef, (test) => {
  test(
    "answers a PARAPHRASED question out of the knowledge base",
    async ({ session }) => {
      // Nothing in this wording appears in the entry's question, so the entry
      // has to be found by the index rather than matched by substring — and the
      // agent has to go looking instead of telling the caller what it knows
      // about voice frameworks in general.
      const turn = await session.say("Can your agents make HTTP requests?");

      expect(toolNames(turn.toolCalls)).toEqual(["search_knowledge"]);
      const call = turn.toolCalls[0]!;
      expect(typeof (call.args as { query?: unknown }).query).toBe("string");
      // The right entry, out of four: the one this question is really about.
      expect(toolResultIn(turn.toolCalls, "search_knowledge", FaqEntrySchema).question).toBe(
        INTERNET.question,
      );
      // And the reply is that entry's answer rather than an embellishment of
      // it — "quote the knowledge base accurately" is the prompt's rule.
      expect(turn.text).toMatch(/fetch|web_search|http/i);
    },
    {
      stubReply: [
        { tool: "search_knowledge", args: { query: "Can your agents make HTTP requests?" } },
        "Yes — agents run with network access and can use the fetch API or the web_search builtin.",
      ],
    },
  );

  test(
    "lists the topics it really has, not the ones it can imagine",
    async ({ session }) => {
      const turn = await session.say("What topics can you help me with?");

      expect(toolNames(turn.toolCalls)).toEqual(["list_topics"]);
      // Every question in `knowledge.json` and nothing else — the check that
      // catches an index built from a stale copy of the asset.
      expect(toolResultIn(turn.toolCalls, "list_topics", z.array(z.string()))).toEqual(
        faqs.map((f) => f.question),
      );
      expect(turn.completed).toBe(true);
    },
    {
      stubReply: [
        { tool: "list_topics" },
        "I can cover what AAI is, how tools work, speech providers, and network access.",
      ],
    },
  );

  test(
    "says it does not know rather than answering off-base",
    async ({ session }) => {
      // The knowledge base has four entries and none of them is the weather.
      // A model asked this will answer it unless the prompt holds — and an FAQ
      // bot that answers from outside its own asset is the failure this
      // template exists to demonstrate the fix for.
      const turn = await session.say("What's the weather in Paris right now?");

      expect(turn.text).toMatch(/can.?t|cannot|do(n.?t| not) have|not something I/i);
      // No degrees, no forecast: whatever it says, it must not have invented an
      // answer, and it may not have found one in a knowledge base without one.
      expect(turn.text).not.toMatch(/\d+\s*(°|degrees)/i);
      for (const call of turn.toolCalls) {
        // `toolResultIn` over a ONE-CALL list: the name is this call's own, so
        // the reader's "no such call" and "two calls" throws are unreachable and
        // what is left is the parse plus its "never completed" failure — which
        // is exactly what the local helper this replaced did by hand.
        expect(toolResultIn([call], call.name)).not.toMatchObject({
          question: expect.stringContaining("weather"),
        });
      }
    },
    // Live only: a scripted model saying "I don't know" proves that the script
    // said so, which is not the claim. `{ live: true }` is the honest way to
    // write a case a stub cannot satisfy.
    { live: true },
  );
});
