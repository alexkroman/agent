import { agent } from "@alexkroman1/aai";

// No providers declared: the agent runs the default all-AssemblyAI cascaded
// pipeline (`...assemblyAIPipeline()`), billed to ASSEMBLYAI_API_KEY.
export default agent({
  name: "Simple Assistant",
});
