import { agent } from "@alexkroman1/aai";
import { PRODUCT, supportProjection } from "./shared.ts";

/**
 * A support line that grades its own retrieval before it speaks — the
 * self-RAG / CRAG graph, ported to voice. `procedure.ts` holds the loop, `prompts.ts`
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
  // The projection is also the privacy boundary: a logged ticket carries the
  // caller's callback number, and only its reference crosses to the browser.
  syncState: supportProjection,
  greeting: `${PRODUCT} support, you're through to the automated line. What's happened?`,
  // A support line is a PHONE line, so this one declares the carrier its number
  // is with. Nothing serves `WS /phone` without this — the route is an
  // allow-list, and an agent that says nothing about carriers answers none — so
  // point a Twilio number's webhook at the deployed agent's `/phone` and the
  // call lands in an ordinary session. `true` admits every carrier the runtime
  // ships a codec for; a list is the narrower statement, and it is the one to
  // copy.
  telephony: ["twilio"],
});
