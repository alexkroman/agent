---
"aai-server": patch
"aai-studio-server": patch
"aai-guest": patch
"aai-studio-client": patch
---

Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
