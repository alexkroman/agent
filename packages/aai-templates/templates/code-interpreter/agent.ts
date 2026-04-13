import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Coda",
  systemPrompt,
  greeting:
    "Hey, I'm Coda. I solve problems by writing and running code. Try asking me something like, what's the 50th fibonacci number, or what day of the week was January 1st 2000.",
  builtinTools: ["run_code"],
});
