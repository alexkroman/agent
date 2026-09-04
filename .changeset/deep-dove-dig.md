---
"aai-server": patch
---

Deploy the guest change that comes with `aai start`: `@alexkroman1/aai-cli` joins WORKSPACE_DEPENDENCIES, the platform-owned set.

A scaffolded project's `npm start` runs `aai start` now, so the CLI is a runtime dependency rather than a devDependency. It is already baked into the guest image with the rest of the toolchain, so nothing about the guest changes — what changes is that `update_dependencies` must refuse to bump it when a workspace names it by hand, which is what that set is for. The carrier is named here because `aai-guest` reaches production only through the image the server pins at deploy time.
