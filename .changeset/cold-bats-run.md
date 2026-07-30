---
"@alexkroman1/aai": minor
---

Three type-level hardenings: (1) branded env records (AgentEnv/ProviderEnv/HostCredentialEnv in sdk/env-types) make it a compile error for withHostCredentialFallback output to become ctx.env; (2) the host-guest NDJSON connection is typed by a per-direction RPC method map (RpcSchema / GuestRpcSchema) so method names and request params are compile-checked while untrusted wire data stays unknown; (3) Manifest is now derived from ManifestSchema (defaults live in the schema, type via z.infer) instead of a hand-declared duplicate.
