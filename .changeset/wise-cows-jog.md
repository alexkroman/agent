---
"aai-server": patch
"aai-studio-server": patch
---

Fix five production failures found in one day of Modal logs. A pinned harness image now resolves from EITHER image source: setting GUEST_IMAGE_REGISTRY orphaned every `agents.harness_image_tag` recorded before the flip, because a tag is source-independent but the published IMAGE is not, so every agent deployed earlier answered 503 behind a Modal error whose exception text is empty. The boot capacity check now reads how the admin pool is ROUTED — with PLATFORM_POOLER_URL unset it printed `capacity ok — 0 spare` one line under the warning naming the 20 fleet-wide connections it was not counting, so the 53300 exhaustion those predict arrived unwarned. An unreachable Supabase Auth or Storage answers 503 rather than 500, and a storage failure keeps its cause instead of stopping at undici's `fetch failed`. And GET /robots.txt returns a policy rather than 400 from the slug validator.
