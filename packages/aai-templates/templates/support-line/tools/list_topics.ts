import { tool } from "@alexkroman1/aai";
import { DOCS, PRODUCT, TOPICS } from "../shared.ts";

/**
 * What the knowledge base covers.
 *
 * Not a retrieval path — it is how the agent steers a caller who opens with
 * "I've got a problem" instead of a question, and how it says what it CAN help
 * with when `answer_question` comes back empty.
 */
export const listTopics = tool({
  description:
    "List what the knowledge base covers. Use this when the caller does not " +
    "know what to ask, or to say what you can help with after a failed lookup.",
  execute() {
    return {
      product: PRODUCT,
      topics: TOPICS,
      articles: DOCS.map((doc) => doc.title),
    };
  },
});
