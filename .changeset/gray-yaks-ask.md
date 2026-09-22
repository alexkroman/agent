---
"@alexkroman1/aai": minor
---

Add `userTurnLimit` — a cap on one user turn by words (`maxWords`) and/or elapsed time (`maxDurationMs`), off by default. Past either cap the transcriber ends the turn as a pause would, so the words heard so far commit and the rest opens the next turn; each cut is a new `user-turn.exceeded` session event. `SttSession` gains an optional `forceEndOfTurn()`, implemented for AssemblyAI (`ForceEndpoint`).
