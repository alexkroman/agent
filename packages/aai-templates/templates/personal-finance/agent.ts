import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Penny",
  systemPrompt,
  greeting:
    "Hey, I'm Penny, your personal finance helper. Try asking me something like, what's 100 dollars in euros, what's the price of bitcoin, or help me split a 120 dollar bill four ways with 20 percent tip.",
  builtinTools: ["run_code", "fetch_json"],
  // The external APIs the system prompt points at. fetch_json runs host-side
  // and doesn't need them, but declaring them keeps any custom tool-code
  // fetch to the same services working once deployed.
  allowedHosts: ["open.er-api.com", "api.coingecko.com"],
});
