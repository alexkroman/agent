import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";

// Push-to-talk translator on sync transports: the client (client.tsx)
// records while the button is held — no VAD, releasing the button IS the
// endpoint — and sends the clip as one `POST /sync` request. AssemblyAI's
// Sync API transcribes it, the LLM translates, and Cartesia's one-shot
// bytes endpoint speaks the translation back. One HTTP round trip per
// phrase, no WebSocket anywhere.
//
// A translator is the ideal one-shot transform agent: every utterance is
// independent, so the reply is just the translation — no chat, no
// follow-ups. Change the language pair by editing the systemPrompt.
export default agent({
  name: "push-to-talk-translator",
  greeting: "Hold the button, speak, release — I'll say it in the other language.",
  systemPrompt:
    "You are a translator between English and Spanish. Translate every user " +
    "message into the other language: English input becomes Spanish, Spanish " +
    "input becomes English. Output ONLY the translation — no explanations, " +
    "no quotation marks, no commentary. Preserve tone and register.",
  stt: assemblyAI(), // Sync API transcribes each held-button clip
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: cartesia(), // one-shot synthesis speaks the translation
});
