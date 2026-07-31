---
"@alexkroman1/aai": patch
---

Recover from a false barge-in during a reply's playback tail: a noise-triggered interruption after the turn finished server-side used to kill the rest of the reply permanently (full transcript shown, voice cut mid-sentence, no resume). The false-interruption recovery window is now armed for playback-tail cuts too, with a continuation prompt that quotes the estimated last words the caller heard.
