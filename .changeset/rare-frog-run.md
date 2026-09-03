---
"aai-server": patch
---

Log a platform admin reservation's statement duration on the SUCCESS path, so the guest's elapsed minus (waitedMs + workMs) is really computable
