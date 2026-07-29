---
"@alexkroman1/aai": patch
---

S2S and OpenAI Realtime now send close code 1000 on an intentional close, so a 1005 in the logs unambiguously means the peer dropped the socket rather than our own teardown.
