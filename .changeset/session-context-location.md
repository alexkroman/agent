---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`sessionContext` may answer `location`: it replaces the socket's `?location=` as the session's location, so `google_places` and `open_meteo` use the app's address. Held to the same rule (control characters stripped, over 200 characters ignored) and never logged. `sessionClientLocation(ctx)` on `@alexkroman1/aai` reads the session's effective location from a custom tool, and `createToolContext({ clientLocation })` seeds it in a test.
