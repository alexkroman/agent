---
"@alexkroman1/aai": minor
---

Re-arm the playback jitter buffer on underrun and conceal gaps instead of zero-filling them, report per-turn concealment counters in WebRTC's shape, pace server audio at a bounded lead, capture through an AudioContext at the STT rate (no worklet resampling), and detect a microphone that only ever delivers silence.
