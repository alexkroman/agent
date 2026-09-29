---
"@alexkroman1/aai-ui": minor
---

`session.resume(sessionId)` (on `createBrowserSession`, `useSession()` and `useSessionActions()`) continues an earlier session without a reload: it hangs up the current call, clears the transcript, stores the id as a `config` frame's would be, and connects presenting it as `?sessionId=`, so the server restores that session's turns (plus the client's other prior sessions as seed, never counting it twice). A malformed id throws a `RangeError` before the current call is touched.
