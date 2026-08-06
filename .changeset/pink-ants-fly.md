---
"@alexkroman1/aai": patch
---

Pin AssemblyAI S2S sessions to the Voice Agent API's only supported sample rate (24 kHz), declare it on the wire, and reject a host-mode handshake that asks for another — a mismatch previously left the agent permanently deaf with no error.
