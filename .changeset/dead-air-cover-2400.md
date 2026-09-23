---
"@alexkroman1/aai": patch
---

Lower the default `deadAirCoverMs` from 5000 to 2400. A pipeline turn that goes silent without a tool call (a slow first token or a long reasoning phase) now hears its first filler at 2.4s — the same point a typical tool-calling turn already did — which is ~4.0s after the caller stopped speaking instead of ~6.7s. Turns that answer within 2.4s, and tool-calling turns, are unchanged. Set `deadAirCoverMs: 5000` to keep the old timing, or `0` to disable the filler.
