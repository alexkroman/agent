---
"@alexkroman1/aai": minor
---

Speak up when a pipeline session cannot start, and actually honor `errorPhrase`. STT and TTS open independently, so the common provider failure leaves the agent with a working voice and nothing to listen with — and it said nothing, handing the caller a line that sounds connected and never answers. A failed open now speaks `startFailurePhrase` (new; defaults to DEFAULT_START_FAILURE_PHRASE, `""` disables) and drains it before teardown. Separately, `errorPhrase` was never forwarded from the agent config to the pipeline transport, so an agent that set it — including setting it to `""` to disable the recovery phrase — silently got the default; it is now passed through like `holdPhrase`.
