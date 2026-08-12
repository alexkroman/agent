import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import knowledge from "./knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

// Search text is static, so it's normalized once at module load — per-call
// work stays O(query) even when the knowledge base grows.
const searchable = faqs.map((entry) => ({
  entry,
  text: `${entry.question} ${entry.answer}`.toLowerCase(),
}));

export default agent({
  name: "FAQ Bot",
  systemPrompt:
    "You are a friendly FAQ assistant. Answer questions using ONLY the information from your embedded knowledge base. If the user asks something not covered by your knowledge base, say you don't have that information and suggest they check the official documentation.\n\nRules:\n- Keep answers concise and conversational — this is a voice agent\n- Quote the knowledge base accurately, do not embellish\n- If a question is ambiguous, ask the user to clarify\n- Use 'search_knowledge' to find answers to specific questions\n- Use 'list_topics' to see all available FAQ topics\n- Always be helpful and polite",
  greeting:
    "Hi! I'm your FAQ assistant. Ask me anything about the AAI agent framework and I'll look it up in my knowledge base.",

  tools: {
    list_topics: tool({
      description: "List all available topics in the embedded FAQ knowledge base.",
      async run() {
        return faqs.map((f) => f.question);
      },
    }),

    search_knowledge: tool({
      description:
        "Search the embedded FAQ knowledge base for an answer matching the user's question.",
      input: z.object({
        query: z.string().describe("The user's question to search for"),
      }),
      async run(args) {
        // Score by word overlap — natural questions rarely match an FAQ
        // entry as an exact substring.
        const words = args.query
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 2);
        if (words.length === 0) return { result: "No matching FAQ found." };

        let best: { entry: FaqEntry; score: number } | null = null;
        for (const { entry, text } of searchable) {
          const score = words.filter((w) => text.includes(w)).length;
          if (score > 0 && (!best || score > best.score)) best = { entry, score };
        }
        return best?.entry ?? { result: "No matching FAQ found." };
      },
    }),
  },
});
