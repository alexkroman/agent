---
"aai-server": patch
"aai-studio-server": patch
"aai-studio-client": patch
"aai-guest": patch
"aai-evals": patch
---

Lower the engines floor on the private packages from Node >=26 to >=24, matching the published packages and the scaffold. The deployed images still run Node 26; the floor only stops a warning on every install under Node 24.
