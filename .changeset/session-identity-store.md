---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

`createToolContext({ clientPhone, clientLocation })` now records the phone number and location the way the runtime records `?phone=` and `?location=`: the number is stored in E.164 (`"+1 (503) 555-0123"` reads back as `"+15035550123"` from `sessionClientPhone`, and a number that is not E.164 reads back `undefined`), and the location goes through the same cleanup rule. Before this, a spec's context stored both exactly as given, so it could pass on a number production would have dropped. Internally, one session-identity store now does the writing, eviction and normalizing that the four session maps each did on their own.
