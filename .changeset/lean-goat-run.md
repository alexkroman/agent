---
"@alexkroman1/aai-runtime": patch
---

Fix silently mute audio on Node 24, and pin the SDK to its declared engine floor. `base64ToUint8` called `Uint8Array.fromBase64` — a Stage 3 proposal absent from Node 24 — inside a `try` whose `catch` exists for a malformed payload, so the `TypeError` was swallowed and every audio frame decoded to zero bytes. Measured on Vercel nodejs24.x: 77 TTS frames in, 77 empty, 0 emitted; a deployed voice agent transcribed the caller, answered in text, and said nothing. Affected every audio path (TTS, S2S, telephony, OpenAI Realtime) on any Node 24 or 25 host, plus binary workflow values, which failed with a mislabelled error instead. The decode now feature-detects once and falls back to a validating decoder; `tsconfig` pins `lib` to ES2025, `@types/node` to the 24 line, and CI runs the engine floor rather than the newest Node.
