import { agent } from "@alexkroman1/aai";
import { desk, deskSlot } from "./shared.ts";

/**
 * A front desk that hands the caller between three personas — the worked
 * example for a SPEAKING roster (`agent({ roster })`). `shared.ts` declares it and each
 * desk's tools; `tools/verify_account.ts` is the one tool every desk carries.
 *
 * `system-prompt.md` is what holds at EVERY desk. The active persona's own
 * instructions are appended under it, per model step, and change on a handoff;
 * the file does not.
 */
export default agent({
  name: "Northwind Front Desk",
  listing:
    "Answers the phone for an internet provider and hands the caller between triage, billing and support",
  greeting: "Northwind Internet, front desk. Is this about your bill, or about your service?",
  roster: desk,
  syncState: deskSlot.projected,
});
