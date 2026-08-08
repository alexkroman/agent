---
"@alexkroman1/aai": patch
---

Recognise the S2S reply.content_part.started/done bracket frames. The service sends them around every reply; absent from the message union each took the unrecognised path and logged a warning, burying the one signal that says a frame the service really sends is going unhandled.
