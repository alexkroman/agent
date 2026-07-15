---
"@alexkroman1/aai-cli": patch
---

Simplify CLI internals: per-command API key gating (--help and aai test/build no longer prompt; --skip-api now effective), server URLs normalized against trailing slashes, deploy/getServerInfo share one resolution path, faster bundling (worker eval no longer waits on the client build; parallel file copies/reads), and remove duplicated template/deploy test scaffolding.
