---
"@alexkroman1/aai-runtime": patch
---

Refuse boot without AAI_PUBLIC_ORIGIN on a platform tier, and stop treating a full disk as transient. The origin was optional on the reading that only durable webhook URLs needed it; it is now the only source of the base URL a guest needs to install the platform workflow world, so unset meant every durable run silently ran on the DevKit's local world and died with its sandbox. ENOSPC now maps to 507 with no Retry-After, instead of falling through to a 500 that three layers retried.
