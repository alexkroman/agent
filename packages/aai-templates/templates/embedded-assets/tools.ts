import knowledge from "./knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

export default {
  tools: {
    search_knowledge: {
      description:
        "Search the embedded FAQ knowledge base for an answer matching the user's question.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The user's question to search for",
          },
        },
        required: ["query"],
      },
      execute: (args: Record<string, unknown>) => {
        const query = args.query as string;
        const q = query.toLowerCase();
        const match = faqs.find(
          (f) =>
            f.question.toLowerCase().includes(q) ||
            q.includes(f.question.toLowerCase()) ||
            f.answer.toLowerCase().includes(q),
        );
        return match ?? { result: "No matching FAQ found." };
      },
    },
    list_topics: {
      description:
        "List all available topics in the embedded FAQ knowledge base.",
      execute: () => faqs.map((f) => f.question),
    },
  },
} satisfies AgentTools;
