---
"@alexkroman1/aai": minor
---

zod is a peerDependency of @alexkroman1/aai and @alexkroman1/aai-runtime rather than a plain dependency. Both packages expose zod types in their published .d.ts, so a consumer's schema has to be the same type the SDK accepts — which only a peer can promise. Install zod alongside them (the scaffold already does); npm 7+ and pnpm 8+ install peers automatically.
