---
"aai-server": patch
---

Track the SDK export renames through the platform.

The API naming review renamed 63 SDK exports, and platform source consumes them: the guest harness, the sandbox and upload paths in aai-server, and the studio prompts in aai-studio-server all name renamed symbols. Two of the edits are load-bearing rather than cosmetic — `store-conformance.ts`'s registered factory names are asserted to resolve to real exports, and the studio prompt text tells the coding agent which functions to write.

Naming a carrier deliberately, so the platform ships with the SDK release rather than lagging it: an SDK-only changeset would bump the carriers as dependents, which the deploy-changeset gate treats as not enough.
