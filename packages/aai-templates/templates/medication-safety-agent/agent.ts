import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Dr. Sage",
  greeting:
    "Hey, I'm Dr. Sage. Try asking me something like, what are the side effects of ibuprofen, can I take aspirin and warfarin together, or calculate my BMI. Just remember, I'm not a real doctor, so always check with your healthcare provider.",
  // Three builtins, and `fetch_json` is the one worth explaining: `fda.ts`
  // already reaches openFDA's LABEL endpoint in tool code, and a label is the
  // manufacturer's text. What the two tools cannot answer is what people
  // actually REPORT, which lives in a different dataset (`/drug/event.json`)
  // and is a counting query rather than a lookup — so it is the model's to
  // compose, not a fixed tool's. `system-prompt.md` holds the endpoint and the
  // caveat that a report count is not an incidence rate.
  builtinTools: ["web_search", "run_code", "fetch_json"],
});
