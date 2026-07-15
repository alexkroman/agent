---
"@alexkroman1/aai": patch
---

Pipeline/host latency: the greeting now starts as soon as the TTS provider connects instead of waiting for the slower STT connect; tool-call yields use setImmediate instead of setTimeout(0) (~2ms less overhead per call); the Vercel tool map is built once per session instead of per turn; provider sockets close in parallel on stop.
