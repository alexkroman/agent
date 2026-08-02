---
"aai-server": patch
"aai-studio-server": patch
---

Resolve the public origin through aai-server/public-origin instead of the in-container request URL, so studio Publish deploys over https and keeps its Authorization header, and the bare-slug redirect stops downgrading the scheme. Version bump so both Modal apps redeploy.
