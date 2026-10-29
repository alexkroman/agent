---
"@alexkroman1/aai-runtime": patch
---

The pipeline's opening dead-air filler ("I'm checking on this.") no longer fires
early because the model called a tool. When the STT timed the caller's last
word, the opening filler waits for its anchored target (4.6s after that word),
and a tool call can no longer pull it in to the 1200ms tool window. The filler
is about 1.7s of audio on the same TTS stream as the reply, so an answer that
arrived while it played waited for it to finish. On tau2-bench retail, 184 of
242 turns' first filler came from the tool window, and 60% of the answers that
followed a filler waited behind it (median 1.13s). Replayed with this floor,
opening fillers after a tool call fell from 156 to about 110 and delayed answers
from 40 to 17. Gaps after the model has spoken, and turns without word timings,
keep the tool window.
