import { tool } from "@alexkroman1/aai";
import { z } from "zod";

/**
 * The two fields this tool reads out of wttr.in's JSON.
 *
 * Narrowed by hand rather than typed as the whole response: a tool's result is
 * recorded in the conversation and sent to the model, so returning everything
 * a third-party API happens to include spends context on fields nobody reads.
 */
type Wttr = {
  current_condition?: [{ temp_F?: string; weatherDesc?: [{ value?: string }] }];
};

// This file IS the tool. It sits in `tools/`, so the model calls it
// `get_weather` — the filename and nothing else names it, and neither
// `agent.ts` nor any list mentions it. Adding an ability is adding a file
// here.
export default tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. Denver") }),
  execute: async ({ city }, ctx) => {
    // `ctx.signal` is the tool call's own deadline. Passing it means a slow
    // service ends the FETCH rather than being waited out and then discarded,
    // which on a live call is the difference between a short apology and a
    // silence the caller hangs up on.
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: ctx.signal,
    });
    // Returned, not thrown: a tool failure the model can read is one it can
    // apologize for out loud, which on a call beats silence.
    if (!res.ok) return { error: `The weather service answered ${res.status}.` };
    const now = ((await res.json()) as Wttr).current_condition?.[0];
    return { city, tempF: now?.temp_F, conditions: now?.weatherDesc?.[0]?.value };
  },
});
