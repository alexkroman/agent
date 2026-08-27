---
"@alexkroman1/aai-runtime": minor
---

Durable-workflow delivery is NOTIFY-driven. enqueue announces on a Postgres channel when a message is due now and a replica listens, so a step-to-step hop no longer pays the poll interval — the same thing graphile-worker does with jobs:insert. The interval stays as the timer for PARKED messages, which a notification cannot express, and as the mechanism that makes delivery eventual when a listener is reconnecting. CloseableDb gains a required listen() member; aai-runtime:db epoch 2 is RETAINED, since adding a member to a type a caller receives is not breaking for a consumer, and a frozen example proves it.
