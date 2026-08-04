---
"@alexkroman1/aai": patch
---

Remove latent footguns: fail-closed env parsing (PORT, SANDBOX_RETIRE_DRAIN_MS, AAI_GUEST_PORT), contained promise rejections in the host-mode handshake, guest RPC dispatch, harness listen, and studio chat body reads, pipeline provider credentials resolving from providerEnv, corrupt agent rows failing closed instead of reading as unclaimed, dead sandboxes no longer preferred by session routing, scrubbed app-db provisioning errors, refusing no-auth dev tokens alongside production config, and full numeric-entity decoding for S3 keys
