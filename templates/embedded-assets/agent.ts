import { defineAgent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import knowledge from "./knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

export default defineAgent({
  name: "FAQ Bot",
  instructions:
    `You are a friendly FAQ assistant. Answer questions using ONLY the information \
from your embedded knowledge base. If the user asks something not covered by your \
knowledge base, say you don't have that information and suggest they check the official \
documentation.

Rules:
- Keep answers concise and conversational — this is a voice agent
- Quote the knowledge base accurately, do not embellish
- If a question is ambiguous, ask the user to clarify
- Use 'search_knowledge' to find answers to specific questions
- Use 'list_topics' to see all available FAQ topics
- Always be helpful and polite`,
  greeting:
    "Hi! I'm your FAQ assistant. Ask me anything about the AAI agent framework and I'll look it up in my knowledge base.",
  voice: "156fb8d2-335b-4950-9cb3-a2d33befec77", // Helpful Woman
  tools: {
    search_knowledge: tool({
      description:
        "Search the embedded FAQ knowledge base for an answer matching the user's question.",
      parameters: z.object({
        query: z.string().describe("The user's question to search for"),
      }),
      execute: ({ query }) => {
        const q = query.toLowerCase();
        const match = faqs.find((f) =>
          f.question.toLowerCase().includes(q) ||
          q.includes(f.question.toLowerCase()) ||
          f.answer.toLowerCase().includes(q)
        );
        return match ?? { result: "No matching FAQ found." };
      },
    }),
    list_topics: {
      description:
        "List all available topics in the embedded FAQ knowledge base.",
      execute: () => faqs.map((f) => f.question),
    },
  },
});
