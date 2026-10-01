---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Transport capabilities: every transport declares one Transport.capabilities descriptor, read instead of probing verbs. A transport's missing features are reported once at session start rather than degrading at the call: speech.say() on an S2S agent now settles "dropped" (SpeechOutcome loses "unsupported"), and the dialog/persona knob warnings come from the descriptor once per runtime.
