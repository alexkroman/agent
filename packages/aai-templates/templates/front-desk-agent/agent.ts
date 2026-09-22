import { agent } from "@alexkroman1/aai";
import { desk, deskSlot } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

/**
 * A front desk that hands the caller between three personas — the worked
 * example for `agent({ personas })`. `shared.ts` declares the roster and each
 * desk's tools; `tools/verify_account.ts` is the one tool every desk carries.
 *
 * `systemPrompt` here is what holds at EVERY desk. The active persona's own
 * instructions are appended under it, per model step, and change on a handoff;
 * this file's prompt does not.
 */
export default agent({
  name: "Northwind Front Desk",
  description:
    "Answers the phone for an internet provider and hands the caller between triage, billing and support",
  systemPrompt,
  greeting: "Northwind Internet, front desk. Is this about your bill, or about your service?",
  personas: desk,
  syncState: deskSlot.projected,
});
