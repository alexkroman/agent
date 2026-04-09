import knowledge from "../knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

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
