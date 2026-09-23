---
"@alexkroman1/aai-runtime": patch
---

`stepSpeak` now honours a workflow cancel and reports an abort faithfully. The
synthesizer follows the walk's signal the way `stepFetch` does, so cancelling a
run closes its in-flight synthesis socket instead of leaving it open until the
120s deadline; an abort rejects with the signal's own `reason` rather than a
fresh `Error` wrapping it, so the replay engine recognises a cancelled walk
instead of retrying the step or journaling it `failed`; and an already-aborted
signal no longer dials a socket only to terminate it.
