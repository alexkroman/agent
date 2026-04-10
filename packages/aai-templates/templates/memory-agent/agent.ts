import { agent } from "aai";
import systemPrompt from "./system-prompt.md";

export default agent({
  name: "Memory Agent",
  systemPrompt,
  greeting:
    "Hey there. I'm an assistant with a long-term memory. Tell me things you want me to remember, and I'll recall them in future conversations.",
  builtinTools: ["web_search"],
});
