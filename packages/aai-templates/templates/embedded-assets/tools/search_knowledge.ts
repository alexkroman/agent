import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { type FaqEntry, searchable } from "../shared.ts";

export default tool({
  description: "Search the embedded FAQ knowledge base for an answer matching the user's question.",
  inputSchema: z.object({
    query: z.string().describe("The user's question to search for"),
  }),
  async execute(args) {
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
});
