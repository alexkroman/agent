---
"@alexkroman1/aai-runtime": minor
---

Evals can say WHO is calling: `clientId`, `phone` and `call` on `openEvalSession`, `describeEval` and each case's options are recorded where a real connection records them, so `sessionClientId`, `sessionClientPhone`, `sessionCall`, `sessionContext` and `onSessionEnd` see them. A session `sessionContext` refuses is `session.refused` (its `say()` rejects naming the reason), and the greeting a `sessionContext` answers is the one the eval waits for.
