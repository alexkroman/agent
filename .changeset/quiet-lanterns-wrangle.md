---
"aai-templates": minor
"@alexkroman1/aai-cli": patch
---

Add two templates ported from the other two voice-agent frameworks' largest samples.

`hotel-desk` is LiveKit Agents' `hotel_receptionist` — the biggest example in that repository — as a voice agent: a boutique hotel's whole front desk over one seeded `sessionSlot`, verification the TOOLS run (three strikes and a human takes over), a room-booking flow as a `dialog()` whose step is derived from what has been captured and whose read-back is OWED until the caller's next committed turn, a dispute engine that reads the disputed amount off the stored line item, the re-accommodation procedure that moves a double-booked guest up or walks them, a guest-privacy tool whose result cannot leak whether anyone is in house, and a twenty-topic policy book rendered partly from the concierge catalogs. Forty-one tools; `shared.ts` carries the attribution and the their-name → our-name table.

`word-wrangler` is Pipecat's `word-wrangler-gemini-live` phone game — a three-way word game whose upstream is a parallel pipeline running two Gemini Live sessions — as one voice agent: the host is the agent, the AI player is `ctx.generate` on its own prompt with only the current word's context, the referee is a function, the describer's own transcript is what rules a foul, and the two-minute game clock is the `playing` state's `timeout`.

The CLI is named alongside because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
