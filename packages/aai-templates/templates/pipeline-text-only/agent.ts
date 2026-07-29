import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { none } from "@alexkroman1/aai/tts";

// Text-only mode: speech in (STT → LLM), text out. `tts: none()` declares
// there is no synthesis side — replies arrive as text, no TTS key is needed,
// and the default UI shows a record button, an audio-file upload button, and
// the streamed text replies.
export default agent({
  name: "pipeline-text-only",
  greeting: "Hi! Speak or upload an audio file, and I'll reply in text.",
  systemPrompt:
    "You are a helpful assistant. The user speaks to you; your replies are " +
    "read, not heard — answer in clear, well-formatted text.",
  stt: assemblyAI(), // default model: universal-3-5-pro
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: none(),
});
