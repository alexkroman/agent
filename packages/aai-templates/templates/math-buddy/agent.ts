import { agent } from "aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Math Buddy",
  systemPrompt,
  greeting:
    "Hey, I'm Math Buddy. Try asking me something like, what's 127 times 849, convert 5 miles to kilometers, or roll 3 twenty-sided dice.",
  builtinTools: ["run_code"],
});
