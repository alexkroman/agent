import { agent } from "@alexkroman1/aai";
import { PRODUCT, supportSlot, supportView } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";
import { answerQuestion } from "./tools/answer_question.ts";
import { listTopics } from "./tools/list_topics.ts";
import { logTicket } from "./tools/log_ticket.ts";

/**
 * A support line that grades its own retrieval before it speaks — the
 * self-RAG / CRAG graph, ported to voice. `graph.ts` holds the loop, `prompts.ts`
 * the attribution and the graders, `shared.ts` the knowledge base and why its
 * retriever is lexical.
 *
 * **Why this shape is worth the model calls on a phone line.** A naive RAG voice
 * agent retrieves, stuffs the documents into the prompt and speaks — and when
 * retrieval missed, it answers from the nearest document it was handed, which
 * over a phone is indistinguishable from a confident correct answer. The
 * template's own knowledge base is built to bait exactly that: "cancelling your
 * contract" and "cancelling an engineer visit" are two documents, two fees, and
 * one word apart. The document grader is what makes the second one not get
 * spoken as the answer to the first.
 */
export default agent({
  name: `${PRODUCT} Support`,
  // The trace exists before the first tool call, so a resumed connection has
  // something to project.
  state: supportSlot.state,
  // The projection is also the privacy boundary: a logged ticket carries the
  // caller's callback number, and only its reference crosses to the browser.
  syncState: supportSlot.projection(supportView),
  systemPrompt,
  greeting: `${PRODUCT} support, you're through to the automated line. What's happened?`,

  tools: {
    answer_question: answerQuestion,
    list_topics: listTopics,
    log_ticket: logTicket,
  },
});
