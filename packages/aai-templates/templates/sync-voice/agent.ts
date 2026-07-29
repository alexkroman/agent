import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

// A voice agent driven entirely over sync transports — and no custom client:
// `transport: "sync"` below makes the *default* browser client skip the
// WebSocket and run HTTP turns instead. It endpoints speech in the browser
// (WebRTC mic capture + client-side VAD) and sends each utterance — or each
// typed message — as one `POST /sync` request. Server-side, every provider
// call is one-shot HTTP too: AssemblyAI's Sync API transcribes the clip, the
// LLM turn runs to completion, and Cartesia's bytes endpoint synthesizes the
// whole reply.
//
// Sync turns come with pipeline mode, so `transport: "sync"` requires the
// stt/llm/tts triple. The same deployment still answers WebSocket voice
// sessions for clients that open one — the field only tells the default
// client which transport to use. Both providers below matter, though: audio
// input needs an STT provider with a batch endpoint (AssemblyAI), and spoken
// replies need a TTS provider with one-shot synthesis (Cartesia).
export default agent({
  name: "sync-voice",
  greeting: "Hi! Tap the mic and talk to me — or just type.",
  systemPrompt:
    "You are a friendly, concise voice assistant. Replies are spoken aloud, " +
    "so keep them short and conversational — one or two sentences unless " +
    "the user asks for more.",
  transport: "sync", // default client uses HTTP turns — no WebSocket, no client.tsx
  stt: assemblyAI(), // Sync API (universal-3-5-pro) transcribes each utterance
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: cartesia(), // /tts/bytes synthesizes each reply in one request
});
