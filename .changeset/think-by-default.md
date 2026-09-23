---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

The `think` builtin is now on by default. An agent that does not set `builtinTools` gets `think` — a no-op scratchpad the model uses to check a tool result against its policy before the next action, silent on a voice call — and no other builtin; `DEFAULT_BUILTIN_TOOLS` is `["think"]`. This follows Anthropic's published tau-bench result for the same tool (airline pass^1 0.332 → 0.404 on its own, 0.584 with guidance; retail 0.783 → 0.812).

Setting `builtinTools` still REPLACES the default: `builtinTools: ["web_search"]` carries no `think`, so add `"think"` to keep it, and pass `[]` to turn it off. Every agent now sends a tool list and the tool preamble in its system prompt, which a toolless agent did not before. A `tools/think.ts` still wins over the builtin, and no longer logs an "inert" line when the author never named `think`. `expectPromptBuiltinsDeclared` and the eval `stubReply` check count the default as declared.
