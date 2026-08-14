import { tool } from "@alexkroman1/aai";
import { faqs } from "../shared.ts";

export default tool({
  description: "List all available topics in the embedded FAQ knowledge base.",
  async execute() {
    return faqs.map((f) => f.question);
  },
});
