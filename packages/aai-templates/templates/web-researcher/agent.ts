import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Scout",
  greeting:
    "Hey, I'm Scout. I search the web for answers. Try asking me something like, what happened in tech news today, or who won the last World Cup.",
  builtinTools: ["web_search", "visit_webpage"],
});
