---
"@alexkroman1/aai": patch
---

Timestamp every log line, put the STT end-of-turn confidence on the wire, and move per-interim STT logs behind AAI_DEBUG_PARTIALS. (This release also turned `holdPhrase` off by default; the field has since been removed outright in favour of `deadAirCoverMs` — see the dead-air cover entry.)
