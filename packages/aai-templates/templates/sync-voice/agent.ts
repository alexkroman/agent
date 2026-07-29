import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

// A voice agent driven entirely over sync transports: the custom client
// (client.tsx) never opens a WebSocket — it endpoints speech in the browser
// (WebRTC mic capture + client-side VAD) and sends each utterance as one
// `POST /sync` request. Server-side, every provider call is one-shot HTTP
// too: AssemblyAI's Sync API transcribes the clip, the LLM turn runs to
// completion, and Cartesia's bytes endpoint synthesizes the whole reply.
//
// Sync turns come with pipeline mode — nothing here opts in. The same
// deployment still answers WebSocket voice sessions; the client decides
// which transport to use. Both providers below matter, though: audio input
// needs an STT provider with a batch endpoint (AssemblyAI), and spoken
// replies need a TTS provider with one-shot synthesis (Cartesia).
export default agent({
  name: "sync-voice",
  greeting: "Hi! Tap the mic and talk to me — or just type.",
  systemPrompt:
    "You are a friendly, concise voice assistant. Replies are spoken aloud, " +
    "so keep them short and conversational — one or two sentences unless " +
    "the user asks for more.",
  stt: assemblyAI(), // Sync API (universal-3-5-pro) transcribes each utterance
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: cartesia(), // /tts/bytes synthesizes each reply in one request
});
