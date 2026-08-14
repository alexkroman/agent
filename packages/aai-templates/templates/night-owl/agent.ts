import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Night Owl",
  greeting:
    "Hey there, night owl. Try asking me for a cozy movie recommendation, or tell me what time you need to wake up and I'll calculate the best time to fall asleep.",
  builtinTools: ["run_code"],
});
