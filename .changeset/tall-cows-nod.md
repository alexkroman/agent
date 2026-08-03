---
"aai-server": minor
"aai-studio-server": minor
---

Storage redesign: each agent is one Postgres row (aai_platform.agents) — slug, credential hashes, config, content hashes, deploy version — committing content-addressed immutable blobs (blobs/<sha256>) in Storage. The row upsert is the deploy's atomic publish point; manifest.json/config.json and the slug_epochs table are gone (the deploy version is the cross-replica invalidation signal). Secret and storage changes no longer restart sandboxes: they take effect on the next deploy or sandbox rebuild.
