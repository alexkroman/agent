---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

Give `retail` and `travel-concierge` an abandonment state, and `retail`'s confirmation read-back a low temperature.

Both templates hold a staged change in a confirmation gate that nothing settles if the caller hangs up, leaving every sensitive tool legal for the rest of the session. `"@session.timed-out"` now carries each into a `final` state where nothing runs. `retail`'s `awaitingConfirmation` also declares `temperature: 0.2`: reading an order number and a dollar amount back is transcription, and the template already guards the same problem on the way in through `resolve.ts`.
