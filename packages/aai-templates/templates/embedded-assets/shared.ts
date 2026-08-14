import knowledge from "./knowledge.json" with { type: "json" };

export type FaqEntry = { question: string; answer: string };

export const faqs: FaqEntry[] = knowledge.faqs;

/**
 * The searchable index, built once at module load.
 *
 * Search text is static, so normalizing it here keeps per-call work O(query)
 * even when the knowledge base grows — and both tools import this module, so
 * the index is built once for the process rather than once per tool.
 */
export const searchable = faqs.map((entry) => ({
  entry,
  text: `${entry.question} ${entry.answer}`.toLowerCase(),
}));
