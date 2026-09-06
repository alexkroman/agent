---
"@alexkroman1/aai": minor
---

Give `dialog()` the three things a voice call has and a form-filling flow does not: session events, time, and per-phase voice settings.

A state's `on` map accepts `"@<session-event>"` keys (`"@session.timed-out"`, `"@speech.started"`, …), validated against the real event union at declaration and excluded from the event type an author may send by hand; `Dialog.receive()` feeds one in. `DialogStateSpec.timeout` declares a per-state deadline, and `after` is now refused in both the spec and machine forms — a dialog's actor lives for one synchronous window, so a delayed transition could never fire, and the reachability check used to green-light one. A state may also carry `voice`, `bargeIn`, `keyterms`, `toolChoice` and `temperature`, read back through `Dialog.voiceConfig()`. Declaring a dialog in `agent({ dialogs })` is what wires any of it to the runtime; an undeclared dialog gates tools exactly as before.
