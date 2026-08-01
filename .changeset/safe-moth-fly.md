---
"@alexkroman1/aai": major
---

Remove the @alexkroman1/aai/patterns subpath (sequential, parallel, route, orchestrate, evaluatorOptimizer, generateStructured). The combinators had no template coverage and no known consumers; compose multi-step LLM orchestration directly over ctx.generate, converting Zod schemas with z.toJSONSchema() where structured output is needed.
