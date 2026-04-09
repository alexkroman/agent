import knowledge from "../knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

export const description =
  "Search the embedded FAQ knowledge base for an answer matching the user's question.";

export const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "The user's question to search for" },
  },
  required: ["query"],
};

export default async function execute(args: { query: string }, _ctx: unknown) {
  const q = args.query.toLowerCase();
  const match = faqs.find(
    (f) =>
      f.question.toLowerCase().includes(q) ||
      q.includes(f.question.toLowerCase()) ||
      f.answer.toLowerCase().includes(q),
  );
  return match ?? { result: "No matching FAQ found." };
}
