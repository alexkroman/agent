---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Label a caller's PROD in the model's copy of the transcript.

`promptingNote(text)` joins `spelledAloudNote` on `@alexkroman1/aai/internal`, and `commitUserTurn` now composes both — so the model's copy of a user turn may carry `[prompting you for a reply — not an answer, and not a refusal]` while the client's caption and the history entry stay verbatim.

**The failure it targets is measured; whether this fixes it is not.** On a 25-task tau2 retail run, 7 of 14 authenticated calls never attempted the write the task asked for. All seven end in the same loop — the agent asks for confirmation, the caller prods ("hello?", "are you still there?"), the agent re-asks, then abandons — with task 18 closing on `"Understood. No return was submitted. Goodbye."` Calls that attempt the write score 0.86; those seven score 0.000. A prod carries no new information, so the model has nothing to answer and reads the interruption as reluctance.

**It is a LABEL, not an instruction, and that is the whole design.** This branch measured which prompt-rule shapes hold: token-level formatting sticks (a rule about reading identifiers took bare ids from 4.8% to 0.0% of turns), while a rule requiring the model to notice a condition does not — "your FIRST sentence carries the answer or the next question" is shipped, and is followed in 0 of 94 replies. So the runtime does the classifying and the model only reads, which is the seam `spelledAloudNote` already established.

The classifier is deliberately narrow: a pattern match (greetings, "are you still there", "any update", "can you hear me") plus a **residue** check — after removing the matched phrase and a filler vocabulary, more than two words left means the turn carries content and is not a prod. That is what keeps a real answer opening with a greeting ("Hello? Yes, go ahead with the exchange.") unannotated; six such turns, taken verbatim from that run's transcripts, are pinned as negatives. Defeating the classifier fails 12 of the suite's 18 specs and leaves all six negatives passing.
