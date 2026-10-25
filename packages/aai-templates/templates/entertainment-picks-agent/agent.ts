import { agent } from "@alexkroman1/aai";
// The slot declared there syncs itself (`sync: true`), and `agent()` collects
// it only from a module this file imports.
import "./shared.ts";

export default agent({
  name: "Night Owl",
  listing: "Recommends films, music and books for the evening, and works out when to go to bed",
  greeting:
    "Hey there, night owl. Try asking me for a cozy movie recommendation, or tell me what time you need to wake up and I'll calculate the best time to fall asleep.",
  builtinTools: ["run_code"],
});
