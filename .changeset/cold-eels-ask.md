---
"@alexkroman1/aai": patch
---

Pass explicit baseURL to createAnthropic so the SDK's loadOptionalSetting returns before reading process.env['ANTHROPIC_BASE_URL']. The Deno platform server runs without --allow-env, and the missing baseURL caused pipeline-mode sessions to crash on first use.
