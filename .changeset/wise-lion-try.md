---
"@alexkroman1/aai-cli": patch
---

Enforce the two flatness rules that were documented and unenforced. A nested tool file (`tools/billing/refund.ts`) was SKIPPED by a one-level readdir, so the project built an agent with none of its tools and no error anywhere; discovery is recursive now and `toolRegistry` rejects the nested path naming the file, keeping one implementation of the rule. A `system-prompt/` DIRECTORY fell through to the framework default with nothing saying why the prompt had no effect; it is refused, naming the file to rename it to. Both were verified broken before the fix — the same silent absence discovery exists to kill, arriving through the discoverer rather than the registry.
