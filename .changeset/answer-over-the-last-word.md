---
"@alexkroman1/aai-runtime": patch
---

A short or acknowledgement-only final ("Yes.", "uh-huh") that began while the
agent was speaking is now dropped only while the agent is STILL speaking when
the final lands. A caller who answers over the closing words of a question ("…is
that right?" / "Yes.") produces a final that arrives after the reply has
finished playing, and it used to be dropped as a backchannel: the agent then
waited for an answer it had already heard, and the call went silent for good
(the hotel template's spelled-out read-backs hit it on the first early
confirmation). Such a final now commits as the caller's turn. It is still
flagged a backchannel for the confirmation gate — now by its words as well as
its span — so a declared `effect: "write"` still asks once more before running.
