---
"@alexkroman1/aai": patch
"aai-server": patch
---

Internal refactor: split oversized modules at natural seams (no behavior change). `host/runtime.ts` → transport construction extracted to `host/runtime-transport.ts`; `host/transports/pipeline-transport.ts` → STT/TTS provider lifecycle extracted to `host/transports/pipeline-providers.ts`; `aai-server/sandbox-vm.ts` → guest KV/Vector/fetch RPC surface extracted to `sandbox-guest-rpc.ts`. Oversized test files split alongside.
