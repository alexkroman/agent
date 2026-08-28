// The agent `scripts/loadtest-turns.mjs` drives: all three stages stubbed.
//
// Copied over a scaffolded project by `scripts/loadtest-boot.sh stub`. Every
// layer below the providers is the real thing — the socket, the session, the
// turn machine, the tool executor, the state store — so a turn rate measured
// here is the runtime's, with no vendor in it.
import { agent } from "@alexkroman1/aai";
import { stubLlm, stubStt, stubTts } from "./stubs.ts";

export default agent({
  name: "Load Test Agent",
  // Short, because the driver waits out the greeting before its first turn.
  greeting: "Ready.",
  stt: stubStt,
  llm: stubLlm.llm,
  tts: stubTts,
});
