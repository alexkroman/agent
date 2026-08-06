// The `simple` agent template, exactly as `aai init` scaffolds it.
//
// This file is the whole agent. It is not written against the server, the
// runtime, or anything self-hosting-specific — which is the point: the same
// `agent.ts` runs under `aai dev`, deploys to the managed platform with
// `aai publish`, and is served by `server.mjs` here. Swapping in any other
// template means replacing this file and nothing else.

import { agent } from "@alexkroman1/aai";

// No providers declared: the agent runs the default all-AssemblyAI cascaded
// pipeline, billed to ASSEMBLYAI_API_KEY. (Add `voice: "..."` to pick its
// TTS voice, or declare any of stt/llm/tts to swap a single stage.)
export default agent({
  name: "Simple Assistant",
});
