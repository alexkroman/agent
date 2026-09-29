---
"@alexkroman1/aai-runtime": patch
---

In an eval session, the turn in which the agent hangs up (`endSession(ctx)`), and `session.close()`, now wait for the agent's `onSessionEnd` hook to settle — bounded at 10 seconds — so a case can assert what the hook wrote without polling. The runtime still calls the hook without awaiting it everywhere else.
