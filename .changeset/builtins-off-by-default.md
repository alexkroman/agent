---
"@alexkroman1/aai": minor
---

`DEFAULT_BUILTIN_TOOLS` is now empty: an agent that does not set `builtinTools`
gets no built-in tools, `think` included. `think` had been the default on the
strength of Anthropic's published τ-bench result and a five-task comparison
here; its costs on a voice turn (an extra LLM round trip per call, and the tool
preamble added to the prompt) are certain while its benefit on this stack was
never measured. Agents that want it list it: `builtinTools: ["think"]`.
