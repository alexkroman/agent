---
"aai-server": patch
"aai-studio-server": patch
---

Ship the phone-route declaration: the guest harness forwards the agent's `telephony` allow-list to the server it builds, so a deployed agent serves `WS /phone` only for the carriers it names, and the studio's Phone card says so beside the webhook URLs it hands out.
