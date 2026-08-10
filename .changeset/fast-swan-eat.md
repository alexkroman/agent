---
"@alexkroman1/aai": minor
---

Add a telephony front door: agents now serve `WS /phone` for carrier media streams (Twilio, Telnyx), so a phone call runs as an ordinary session on the existing turn-taking, barge-in and pacing stack. Includes G.711 mu-law transcoding and anti-aliased sample-rate conversion at the edge.
