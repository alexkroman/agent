# @alexkroman1/aai-runtime

The host runtime for [AAI](https://github.com/alexkroman/agent) agents: the
thing that actually runs an `agent.ts`.

```ts
import { createAgentServer } from "@alexkroman1/aai-runtime";
```

You need this package if you are **embedding or self-hosting** an agent — it is
what `aai dev` and the managed platform both run, and what a scaffolded
project's `server.mjs` imports.

You do **not** need it to write an agent. Authoring is
[`@alexkroman1/aai`](https://www.npmjs.com/package/@alexkroman1/aai) —
`agent()`, `tool()`, the provider factories — and a browser client is
[`@alexkroman1/aai-ui`](https://www.npmjs.com/package/@alexkroman1/aai-ui).

## Why it is a separate package

It was `@alexkroman1/aai/runtime` until the SDK's authoring surface and its
host implementation were split apart. Two things came out of that:

- **The authoring install got lighter.** Every `@ai-sdk/*` adapter and every
  vendor SDK (Deepgram, ElevenLabs, Cartesia, AssemblyAI), plus `ai`,
  `postgres` and `ws`, are runtime dependencies — 21 packages that an
  `agent.ts` never touches. The provider factories return pure descriptors; the
  host is what resolves them into open sockets.
- **The reference got readable.** The runtime is ~220 exports against the SDK's
  ~90, and it was two thirds of a combined API reference aimed at people
  writing agents.
