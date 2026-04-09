import knowledge from "../knowledge.json" with { type: "json" };

type FaqEntry = { question: string; answer: string };
const faqs: FaqEntry[] = knowledge.faqs;

export default async function execute(_args: unknown, _ctx: unknown) {
  return faqs.map((f) => f.question);
}
