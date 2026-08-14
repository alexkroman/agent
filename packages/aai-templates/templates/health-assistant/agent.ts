import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md?raw";

export default agent({
  name: "Dr. Sage",
  systemPrompt,
  greeting:
    "Hey, I'm Dr. Sage. Try asking me something like, what are the side effects of ibuprofen, can I take aspirin and warfarin together, or calculate my BMI. Just remember, I'm not a real doctor, so always check with your healthcare provider.",
  builtinTools: ["web_search", "run_code"],
});
