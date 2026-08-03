import { agent } from "@alexkroman1/aai";

// No providers declared: the agent runs the default all-AssemblyAI cascaded
// pipeline, billed to ASSEMBLYAI_API_KEY. (Add `voice: "..."` to pick its
// TTS voice, or declare any of stt/llm/tts to swap a single stage.)
export default agent({
  name: "Simple Assistant",
});
