---
"@alexkroman1/aai-runtime": minor
---

Speech made only of acknowledgement words ("mm-hmm", "yeah, right", "exactly"),
when it starts while the agent is speaking, no longer cuts the reply and is not
committed as a turn. The reply keeps playing. The same words after the agent has
stopped still commit as an answer. On Full-Duplex-Bench v1.5, backchannels that
cut the reply fell from 94 of 98 to 4 of 98, and the judged Resume rate rose
0.67 → 0.94.

The barge-in sustained-speech gate no longer reads `SttTurnMeta.spokenMs`. On
`universal-3-5-pro` a turn's first word is timestamped from the start of the
turn window, not from speech, so a one-word "Hmm." spoken over ~1s reported
~1.1s and passed the 500 ms gate at once. An interim now passes when the speech
edge has been open for `interruptionMinDurationMs`, or when it already has 3 or
more words. The `Pipeline barge-in` log line now carries the gate's inputs
(`words`, `spokenMs`, `edgeMs`) and the interim's text.
