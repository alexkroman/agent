---
"aai-ui": major
"aai-templates": patch
---

Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export.

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
