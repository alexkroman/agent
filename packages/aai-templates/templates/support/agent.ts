import { agent } from "aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "AssemblyAI Support",
  systemPrompt,
  greeting:
    "Hi! I'm the AssemblyAI support assistant. I can help you with questions about our speech-to-text API, audio intelligence features, LLM gateway, and more. What can I help you with?",
});
