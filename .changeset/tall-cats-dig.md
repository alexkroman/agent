---
"@alexkroman1/aai": minor
---

Harden credential and SSRF boundaries: SDK network builtins now default to SSRF-protected fetch, provider credential resolution no longer falls back to the host process env, host mode is opt-in, the self-hosted server binds loopback by default, and DNS pinning no longer breaks TLS. The CLI refuses to send credentials to an unapproved serverUrl from .aai/project.json.
