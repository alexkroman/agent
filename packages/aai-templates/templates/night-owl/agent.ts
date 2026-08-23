import { agent } from "@alexkroman1/aai";
import { nightProjection } from "./shared.ts";

export default agent({
  name: "Night Owl",
  // The night's recommendation log, pushed to the client after every tool
  // call. The page renders `useAgentState(nightProjection)` and keeps no copy
  // of its own, so a reload resumes with the list intact.
  syncState: nightProjection,
  greeting:
    "Hey there, night owl. Try asking me for a cozy movie recommendation, or tell me what time you need to wake up and I'll calculate the best time to fall asleep.",
  builtinTools: ["run_code"],
});
