---
"@alexkroman1/aai-cli": patch
---

The starter templates now mark their 34 write tools — bookings, orders,
cancellations, dispatches, sent messages, incident and ticket records — with
`effect: "write"`, so a caller's "uh-huh" spoken over the agent's confirmation
question cannot trigger one. Lookups, cart and draft steps that a later tool
commits, and internal notes stay unmarked.
