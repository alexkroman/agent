# aai-templates

## 0.1.0

### Minor Changes

- d3b39ef: Wire pluggable STT/LLM/TTS providers through the managed-platform sandbox. Previously providers were defined as live Vercel AI SDK / SDK-client instances in agent.ts, which meant the bundle shipped '@ai-sdk/anthropic' etc. into the guest Deno sandbox — the SDK's eager ANTHROPIC_BASE_URL env read crashed under '--allow-env'-free Deno. The server's createRuntime() also ignored stt/llm/tts entirely, so pipeline mode never activated in production. Now factories under @alexkroman1/aai/{stt,tts,llm} return '{ kind, options }' descriptors (JSON-serializable, no AI-SDK imports). The host resolves them to real openers at session start via a new resolver. IsolateConfig carries mode + descriptors through deploy, and sandbox.ts threads them into createRuntime. The agent bundle is now ~66 KB with zero AI-SDK code.

## 0.0.6

### Patch Changes

- 66cbc95: Fix pnpm install failure when scaffolding pipeline-simple template. The template's package.json was replacing the scaffold's, leaving a workspace:\* marker that pnpm cannot resolve outside the monorepo. Pipeline-mode SDKs (ai, assemblyai, @ai-sdk/anthropic, @cartesia/cartesia-js) now live in the scaffold's package.json. Also surface pnpm's actual stdout/stderr on install failure instead of the opaque 'Command failed' wrapper.

## 0.0.5

### Patch Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

## 0.0.4

### Patch Changes

- 27faac9: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients

## 0.0.3

### Patch Changes

- b3bafa7: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients

## 0.0.2

### Patch Changes

- 50cd113: Fix scaffold missing client.tsx and route pnpm install through safe-chain

  - Add client.tsx to scaffold with correct `client` import from aai-ui (fixes build failure from stale `defineClient` reference)
  - Detect safe-chain on PATH and route pnpm install through it with `--safe-chain-skip-minimum-package-age` to avoid blocking newly published packages

## 0.0.1

### Patch Changes

- 486fb23: Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export.

  BREAKING CHANGES:

  - `createSessionControls` removed (merged into `createVoiceSession`)
  - `SessionSignals` type removed
  - `Reactive<T>` type removed
  - `useSession()` return shape changed (returns `VoiceSession` directly)
  - `VoiceSessionOptions` no longer accepts `reactiveFactory` or `batch`
  - `./session` subpath export removed
  - Components removed from exports: `ErrorBanner`, `StateIndicator`, `ThinkingIndicator`, `Transcript`, `MessageBubble`
  - `ButtonVariant`, `ButtonSize` types removed from exports
  - `ClientHandle.signals` removed (use `ClientHandle.session` directly)
