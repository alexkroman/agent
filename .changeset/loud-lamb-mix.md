---
"@alexkroman1/aai": patch
---

Remove the provisional-yield audio duck. It was built to stop the agent barging out on non-directed speech, and never earned its place: the selectivity gain stayed inside the harness's noise floor across every run, while the cost was concrete — roughly 37 false ducks per benchmark run inserting 400ms of silence mid-reply, and a re-arming backstop that deadlocked into a permanently mute agent. The speech_started gate and the cut-point resume, which came in alongside it and are independently validated, stay.
