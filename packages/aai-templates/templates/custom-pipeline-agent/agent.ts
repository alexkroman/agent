import { agent } from "@alexkroman1/aai";
import { anthropicLlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "Custom Pipeline Assistant",
  description: "Answers general questions on a pipeline whose stages you swap one at a time",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  // Declare only the stage you want elsewhere — here the LLM. Every stage
  // left unset (STT and TTS here) runs on the AssemblyAI default, billed to
  // the one key a published agent is guaranteed to have, so swapping a stage
  // never means restating the other two.
  llm: anthropicLlm({ model: "claude-haiku-4-5" }),
});
