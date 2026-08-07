---
"@alexkroman1/aai": patch
---

Split stopping the noise from abandoning the turn: the pipeline now ducks its outgoing audio the moment the caller speaks over it, and only a barge-in that sustains aborts the reply. An aside (a cough, "hold on a second" said to the room) is indistinguishable from a real interruption at its first partial — thresholds cannot separate them, and a stricter word gate measured -12.7 points of yield rate for no selectivity gain — but an aside STOPS and an interruption CONTINUES, so the reply resumes with nothing re-spoken. Also resumes a mid-turn barge-in from the estimated cut point rather than the [interrupted] marker, and rewrites the voice prompt around reply length: a short first sentence, a hard word budget, results instead of narrated intentions, no re-asking for the same identifier, and contractions allowed.
