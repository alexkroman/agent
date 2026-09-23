---
"@alexkroman1/aai-cli": patch
---

Fix `aai console` audio on macOS: the speaker no longer exits after the agent's first reply, and agent speech no longer plays at half speed on Bluetooth headsets. `play` now reads a real pipe (SoX treated Node's socket stdin as end of input the moment the agent paused), and the microphone opens before the speaker so SoX picks up the headset's rate after it switches profiles.
