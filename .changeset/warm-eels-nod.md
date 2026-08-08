---
"@alexkroman1/aai-cli": patch
---

aai secret and aai publish now set secrets on a linked project's preview agent as well as its production one, matching what the studio's Secrets panel already did. Previously a key set from the CLI reached production alone, so the preview agent the same publish created failed at its first session.
