import { z } from "zod";
import { deskGate, gateFlow, stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_excursion`, staged rather than applied. */
export default tripSlot.updateTool({
  description:
    "The EXCURSIONS DESK's booking tool: book an excursion. Only usable while the call is " +
    "at that desk. This does NOT book anything yet — it stages the booking so you can read " +
    "it back and hear a yes.",
  ui: { icon: "\u{1F3AB}", label: "Staging excursion" },
  dialog: gateFlow,
  send: { type: "STAGED" },
  require: deskGate("excursion"),
  inputSchema: z.object({
    excursionId: z.string().max(20).describe("The excursion id from search_excursions, e.g. 'E2'"),
  }),
  execute: (args, trip) =>
    stageAction(trip, { kind: "book_excursion", excursionId: args.excursionId.toUpperCase() }),
});
