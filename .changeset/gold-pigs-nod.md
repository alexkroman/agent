---
"@alexkroman1/aai": patch
---

Remove the unused parseManifest/Manifest layer; toAgentConfig is the single config entry point (ProviderDescriptorSchema now lives in agent-config.ts; the /manifest subpath surface is unchanged).
