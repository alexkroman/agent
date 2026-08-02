import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";

export default agent({
  name: "pipeline-simple",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  // The preset fills all three stages with AssemblyAI, billed to the one key
  // a published agent is guaranteed to have. Spread it, then override the one
  // stage you want elsewhere — here the LLM. Anything not overridden stays
  // AssemblyAI, so swapping a stage never means restating the other two.
  ...assemblyAIPipeline(),
  llm: anthropic({ model: "claude-haiku-4-5" }),
});
