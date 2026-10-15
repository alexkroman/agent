---
"aai-server": patch
"aai-studio-server": patch
---

Keep deployed agents reachable through a platform deploy: a shutting-down
replica hands its agent guests off to the fleet instead of draining them (a
draining guest held its sandbox name and refused every new session for up to ten
minutes), and a guest sandbox now stops the moment its harness exits, releasing
its name.
