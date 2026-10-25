import { agent } from "@alexkroman1/aai";
import { nightSlot } from "./shared.ts";

export default agent({
  name: "Night Owl",
  listing: "Recommends films, music and books for the evening, and works out when to go to bed",
  // The night's recommendation log, pushed to the page after every tool call;
  // the page renders `useAgentState(nightSlot.projected)` and keeps no copy.
  syncState: nightSlot.projected,
  greeting:
    "Hey there, night owl. Try asking me for a cozy movie recommendation, or tell me what time you need to wake up and I'll calculate the best time to fall asleep.",
  builtinTools: ["run_code"],
});
