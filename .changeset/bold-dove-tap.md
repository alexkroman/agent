---
"aai-server": patch
---

Cut latency from the deployed-agent sandbox spawn: write the bundle and env boot artifacts concurrently instead of serially, issue the tunnel lookup before those writes so its round trip overlaps the ~8 MB bundle upload, and tighten the guest readiness probe interval from 250ms to 100ms (the interval is dead time on every spawn — half of it on average — and the probe is a localhost TCP connect inside an idle container).
