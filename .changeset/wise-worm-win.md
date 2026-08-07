---
"@alexkroman1/aai-ui": patch
---

Fail a session whose socket opened but never received a config frame. The server sends config at zero RTT, so an open-but-silent socket means the peer is not a healthy agent server — but partysocket's connection timeout is cleared once the socket opens, so the session reached "ready" (the same live indicator the UI gives "listening") and stayed there permanently with no mic, no error and no retry. It now re-dials on a deadline and surfaces a connection error once the budget is spent.
