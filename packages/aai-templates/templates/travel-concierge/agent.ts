import { agent } from "aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Aria",
  systemPrompt,
  greeting:
    "Hey, I'm Aria, your travel concierge. Try asking me something like, what's the weather in Tokyo this week, or help me plan a long weekend in Barcelona.",
  builtinTools: ["web_search", "visit_webpage", "fetch_json"],
});
