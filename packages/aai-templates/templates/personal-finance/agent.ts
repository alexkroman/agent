import { agent } from "aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Penny",
  systemPrompt,
  greeting:
    "Hey, I'm Penny, your personal finance helper. Try asking me something like, what's 100 dollars in euros, what's the price of bitcoin, or help me split a 120 dollar bill four ways with 20 percent tip.",
  builtinTools: ["run_code", "fetch_json"],
});
