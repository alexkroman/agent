---
"@alexkroman1/aai": patch
---

Disable permessage-deflate on provider WebSockets. The `ws` package enables it by default on clients, so every outbound STT/TTS/S2S socket offered compression; a provider that accepted cost a zlib context per socket (+321 KiB RSS and ~4.5x CPU per socket, measured) to compress PCM16 audio, which does not compress.
