import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";

export default agent({
  name: "pipeline-simple",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  // Declare only the stage you want elsewhere — here the LLM. Every stage
  // left unset (STT and TTS here) runs on the AssemblyAI default, billed to
  // the one key a published agent is guaranteed to have, so swapping a stage
  // never means restating the other two.
  llm: anthropic({ model: "claude-haiku-4-5" }),
});
