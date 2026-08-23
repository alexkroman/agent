// A tool. The file IS the registration: this is `tools/roll_die.ts`, so the
// model calls it `roll_die`, and nothing anywhere names it a second time.
//
// It runs in the server process on the credentials that process holds — so a
// real one reaches your database, your internal API, whatever the reason you
// self-host was. A die is here because it is obviously non-deterministic:
// hearing a number back is proof the model called this file rather than
// answering from its own head.

import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Roll a single die with the given number of sides.",
  inputSchema: z.object({ sides: z.number().int().min(2).max(1000) }),
  execute: ({ sides }) => ({ rolled: 1 + Math.floor(Math.random() * sides) }),
});
